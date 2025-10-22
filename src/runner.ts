import { Actor, Dataset, log } from 'apify';
import {
  InputSchema,
  IssueDurationRecord,
  IssuePipelineSnapshot,
  PersistedState,
  makeIssueKey,
} from './types.js';

// Fix memory snapshot error on Windows by disabling memory monitoring entirely
process.env.APIFY_MEMORY_MBYTES = '0';
import { ZenHubClient, mapRawToSnapshot } from './clients/zenhub.js';
import { GitHubClient } from './clients/github.js';
import {
  GraphQLClient,
  WORKSPACE_ISSUES_QUERY,
  ISSUE_TIMELINE_QUERY,
  WorkspaceIssuesResult,
  IssueTimelineResult,
  extractPipelineEnteredAtFromTimeline,
} from './clients/graphql.js';
import { humanDuration, msToHours, msToMinutes } from './utils/time.js';

function validateInput(input: any): InputSchema {
  if (!input || typeof input !== 'object') throw new Error('Input must be an object');
  if (!input.zenhubToken || typeof input.zenhubToken !== 'string') throw new Error('Missing zenhubToken');
  const useGraphql = Boolean(input.useGraphql);
  if (useGraphql) {
    if (!Array.isArray(input.workspaceIds) || input.workspaceIds.length === 0)
      throw new Error('workspaceIds must be non-empty array when useGraphql is true');
  } else {
    if (!Array.isArray(input.targets) || input.targets.length === 0)
      throw new Error('targets must be non-empty array');
  }
  if (!Array.isArray(input.targetPipelines) || input.targetPipelines.length === 0)
    throw new Error('targetPipelines must be non-empty array');
  return {
    zenhubToken: input.zenhubToken,
    targets: Array.isArray(input.targets)
      ? input.targets.map((t: any) => {
          if (typeof t === 'string') {
            const [owner, name] = t.split('/');
            if (!owner || !name) throw new Error(`Invalid target format: ${t}. Expected owner/name`);
            return { repository: { owner, name } } as any;
          }
          return t;
        })
      : [],
    targetPipelines: input.targetPipelines,
    maxIssues: input.maxIssues ?? 100,
    timeGranularity: 'minutes',
    githubToken: input.githubToken,
    strictPipelineTimestamp: input.strictPipelineTimestamp ?? false,
    useGraphql: useGraphql,
    workspaceIds: input.workspaceIds,
  };
}

export async function run(): Promise<void> {
  const rawInput = (await Actor.getInput()) || {};
  const input = validateInput(rawInput);
  const zenClient = new ZenHubClient({ token: input.zenhubToken });
  const ghClient = new GitHubClient({ token: input.githubToken });
  const gqlClient = input.useGraphql
    ? new GraphQLClient({ endpoint: (rawInput as any).graphqlEndpoint || 'https://api.zenhub.com/graphql', token: input.zenhubToken })
    : null;
  const nowIso = new Date().toISOString();

  const snapshots: IssuePipelineSnapshot[] = [];
  if (input.useGraphql && input.workspaceIds && input.workspaceIds.length > 0 && gqlClient) {
    for (const wid of input.workspaceIds) {
      let after: string | undefined = undefined;
      let collected = 0;
      do {
        const data: WorkspaceIssuesResult = await gqlClient.query<WorkspaceIssuesResult>(WORKSPACE_ISSUES_QUERY, {
          workspaceId: wid,
          after,
        });
        
        if (!data.workspace) {
          log.warning(`No workspace found for ID: ${wid}`);
          break;
        }
        
        log.info(`Found workspace: ${data.workspace.name} (${data.workspace.id})`);
        const nodes = data.workspace.issues.nodes;
        log.info(`Processing ${nodes.length} issues from workspace`);
        
        for (const node of nodes) {
          // Get current pipeline from pipelineIssue
          const currentPipeline = node.pipelineIssue?.pipeline?.name;
          log.debug(`Issue #${node.number}: pipeline="${currentPipeline}", targetPipelines=${JSON.stringify(input.targetPipelines)}`);
          
          if (!currentPipeline || !input.targetPipelines.includes(currentPipeline)) {
            log.debug(`Skipping issue #${node.number} - not in target pipelines`);
            continue;
          }
          
          log.info(`Processing issue #${node.number} in pipeline "${currentPipeline}"`);
          log.debug(`Issue assignees: ${JSON.stringify(node.assignees?.nodes || [])}`);
          
          const assigneeLogins = (node.assignees?.nodes || []).map((a: { login: string }) => a.login);
          const repoRef = { 
            owner: node.repository.owner.login, 
            name: node.repository.name 
          };
          
          // Get draft status from GitHub API for pull requests
          let isDraft: boolean | undefined = undefined;
          if (node.pullRequest && ghClient) {
            try {
              const prDetails = await ghClient.getPullRequest(repoRef, node.number);
              isDraft = prDetails?.draft;
            } catch (e) {
              log.warning(`Failed to get draft status for PR #${node.number}: ${(e as Error).message}`);
            }
          }
          
          const nodeType = node.pullRequest 
            ? (isDraft ? 'Draft Pull Request' : 'Pull Request') 
            : 'Issue';
          log.info(`Issue #${node.number} (${nodeType}, state: ${node.state}) assignees: ${assigneeLogins.length > 0 ? assigneeLogins.join(', ') : 'None'}`);
          
          // fetch timeline for accurate timestamp
          let enteredAt: string | undefined = undefined;
          // Timeline queries are failing, so for now use a fallback strategy:
          // Use updatedAt as approximation when issue was last modified
          try {
            const tl = await gqlClient.query<IssueTimelineResult>(ISSUE_TIMELINE_QUERY, {
              repositoryGhId: node.repository.ghId,
              issueNumber: node.number,
            });
            const events = tl.issueByInfo?.transferEvents?.nodes || [];
            if (currentPipeline) {
              enteredAt = extractPipelineEnteredAtFromTimeline(events, currentPipeline);
            }
          } catch (e) {
            log.warning(`Timeline query failed for issue #${node.number}: ${(e as Error).message}`);
            // Fallback: use updatedAt - this is an approximation
            log.info(`Using updatedAt as fallback timestamp for issue #${node.number}`);
            enteredAt = node.updatedAt;
          }
          
          const fallbackEnteredAt = enteredAt || nowIso;
          if (!enteredAt && input.strictPipelineTimestamp) {
            log.debug(`Skipping issue #${node.number} - strict mode and no timeline timestamp`);
            continue;
          }
          
          const snap: IssuePipelineSnapshot = {
            issueNumber: node.number,
            repo: repoRef,
            title: node.title,
            assignees: assigneeLogins,
            pipeline: currentPipeline,
            pipelineEnteredAt: fallbackEnteredAt,
            updatedAt: nowIso,
            type: node.type,
            state: node.state,
            createdAt: node.createdAt,
            isPullRequest: node.pullRequest,
            isDraft: isDraft,
          };
          snapshots.push(snap);
          collected++;
          if (collected >= (input.maxIssues || 100)) break;
        }
        
        if (collected >= (input.maxIssues || 100)) break;
        after = data.workspace.issues.pageInfo.hasNextPage ? data.workspace.issues.pageInfo.endCursor : undefined;
      } while (after);
    }
  } else {
    for (const t of input.targets) {
    // Resolve repoId if missing and GitHub token provided
    if (!t.repoId && ghClient) {
      try {
        const repoData = await ghClient.getRepo(t.repository);
        t.repoId = repoData.id;
      } catch (e) {
        log.warning(`Failed to resolve repoId for ${t.repository.owner}/${t.repository.name}: ${(e as Error).message}`);
      }
    }
    const rawIssues = await zenClient.listIssuesInRepoUsingBoard(t.repository, t.repoId);
    for (const raw of rawIssues) {
      if (!input.targetPipelines.includes(raw.pipeline)) continue;
      // fetch events to get accurate pipeline entered timestamp
      let enteredAt: string | undefined = undefined;
      if (t.repoId) {
        try {
          const events = await zenClient.listIssueEvents(t.repoId, raw.issueNumber);
          enteredAt = zenClient.extractPipelineEnteredAt(events, raw.pipeline);
        } catch (e) {
          log.warning(`Events fetch failed for issue #${raw.issueNumber}: ${(e as Error).message}`);
        }
      }
      const fallbackEnteredAt = enteredAt || nowIso;
      if (!enteredAt && input.strictPipelineTimestamp) {
        // skip if strict and we couldn't resolve
        continue;
      }
      const snap = mapRawToSnapshot(t.repository, { ...raw, pipelineEnteredAt: enteredAt }, nowIso, fallbackEnteredAt);
      snapshots.push(snap);
    }
  }
  }

  // compute durations
  const records: IssueDurationRecord[] = snapshots.map((s) => {
    const durationMs = Date.now() - Date.parse(s.pipelineEnteredAt);
    const isDraftPR = s.isPullRequest && s.isDraft;
    const typeDisplay = s.isPullRequest 
      ? (isDraftPR ? 'Draft Pull Request' : 'Pull Request') 
      : 'Issue';
    const draftDisplay = s.isPullRequest 
      ? (s.isDraft === true ? 'Draft' : s.isDraft === false ? 'Ready' : 'Unknown') 
      : 'N/A';
    const githubUrl = `https://github.com/${s.repo.owner}/${s.repo.name}/${s.isPullRequest ? 'pull' : 'issues'}/${s.issueNumber}`;
    
    return {
      ...s,
      durationMs,
      durationMinutes: msToMinutes(durationMs),
      durationHours: parseFloat(msToHours(durationMs).toFixed(2)),
      durationHuman: humanDuration(durationMs),
      assigneesCount: s.assignees.length,
      assigneesDisplay: s.assignees.length > 0 ? s.assignees.join(', ') : 'Unassigned',
      typeDisplay,
      draftDisplay,
      githubUrl,
    };
  });

  // sort desc
  records.sort((a, b) => b.durationMs - a.durationMs);

  // Use default dataset so --purge flag can clear it
  await Actor.pushData(records);

  const scopeDesc = input.useGraphql
    ? `${input.workspaceIds?.length ?? 0} workspaces`
    : `${input.targets.length} targets`;
  log.info(`Collected ${records.length} issues across ${scopeDesc}.`);
  if (records[0]) {
    log.info(
      `Longest: ${makeIssueKey(records[0].repo, records[0].issueNumber)} (${records[0].typeDisplay}) in ${records[0].pipeline} for ${records[0].durationHuman} (assigned: ${records[0].assigneesDisplay})`,
    );
  }

  // Log summary of assignees and types
  const unassignedCount = records.filter(r => r.assigneesCount === 0).length;
  const assignedCount = records.length - unassignedCount;
  const prCount = records.filter(r => r.isPullRequest).length;
  const draftPrCount = records.filter(r => r.isPullRequest && r.isDraft === true).length;
  const readyPrCount = records.filter(r => r.isPullRequest && r.isDraft === false).length;
  const unknownPrCount = prCount - draftPrCount - readyPrCount;
  const issueCount = records.length - prCount;
  
  const prSummary = unknownPrCount > 0 
    ? `${prCount} pull requests (${draftPrCount} draft, ${readyPrCount} ready, ${unknownPrCount} unknown)`
    : `${prCount} pull requests (${draftPrCount} draft, ${readyPrCount} ready)`;
  
  log.info(`Type summary: ${issueCount} issues, ${prSummary}`);
  log.info(`Assignment summary: ${assignedCount} assigned, ${unassignedCount} unassigned`);
  
  if (assignedCount > 0) {
    const assigneeSet = new Set(records.flatMap(r => r.assignees));
    log.info(`Assignees involved: ${Array.from(assigneeSet).join(', ')}`);
  }
  
  // Send results to Slack webhook
  const webhookUrl = 'https://hooks.slack.com/triggers/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';
  const REVIEW_DEADLINE_DAYS = 3; // Number of days to complete review
  const WARNING_THRESHOLD_DAYS = 5; // Yellow warning threshold
  const URGENT_THRESHOLD_DAYS = 7; // Red urgent threshold
  // Above URGENT_THRESHOLD_DAYS = Critical (fire emoji)
  
  try {
    log.info('Sending results to Slack webhook...');
    
    // Filter only Issues (not Pull Requests), only assigned, and only problematic ones
    const assignedIssues = records.filter(r => {
      const durationDays = r.durationHours / 24;
      return r.assigneesCount > 0 && !r.isPullRequest && durationDays >= REVIEW_DEADLINE_DAYS;
    });
    
    // Build main message with assigned issues only
    let textSummary = '';
    
    if (assignedIssues.length > 0) {
      // Find max lengths for padding
      const maxNameLength = Math.max(...assignedIssues.map(r => r.assigneesDisplay.length));
      const maxDurationLength = Math.max(...assignedIssues.map(r => r.durationHuman.length));
      
      assignedIssues.forEach((r, idx) => {
        const durationDays = r.durationHours / 24;
        let emoji = '';
        if (durationDays < WARNING_THRESHOLD_DAYS) {
          emoji = '⚠️';  // REVIEW_DEADLINE_DAYS - WARNING_THRESHOLD_DAYS
        } else if (durationDays < URGENT_THRESHOLD_DAYS) {
          emoji = '🚨';  // WARNING_THRESHOLD_DAYS - URGENT_THRESHOLD_DAYS
        } else {
          emoji = '😱';  // URGENT_THRESHOLD_DAYS+
        }
        
        // Pad name and duration for alignment
        const paddedName = r.assigneesDisplay.padEnd(maxNameLength, ' ');
        const paddedDuration = r.durationHuman.padEnd(maxDurationLength, ' ');
        
        textSummary += `${emoji} ${paddedName}  ${paddedDuration}\n`;
        textSummary += `   ${r.githubUrl}\n`;
        textSummary += `   ${r.title}\n`;
        
        // Add separator line between issues (but not after the last one)
        if (idx < assignedIssues.length - 1) {
          textSummary += `   ─────────────────────────────────\n`;
        }
        textSummary += `\n`;
      });

        textSummary += `\nEvery PR should be reviewed within ${REVIEW_DEADLINE_DAYS} days.`;
        textSummary += `\nPlease look to your assigned issues and comment in the thread if there’s any blocker or reason for the delay.`;

    } else {
      textSummary += `✅ Great work! All reviews are on track. 🎉`;
    }
    
    if (assignedIssues.length > 0) {
    //   textSummary += `\n\n<@U06S5J19SQN>`;
    }

    const payload = {
      text: textSummary
    };
    
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    
    if (!response.ok) {
      throw new Error(`Webhook request failed with status ${response.status}: ${await response.text()}`);
    }
    
    log.info('Successfully sent main message to Slack webhook');
    
  } catch (error) {
    log.error(`Failed to send results to Slack webhook: ${(error as Error).message}`);
    // Don't throw - we still want the actor to succeed even if webhook fails
  }
}
