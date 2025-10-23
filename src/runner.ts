import { Actor, log } from 'apify';

import { GitHubClient } from './clients/github.js';
import type { WorkspaceIssuesResult} from './clients/graphql.js';
import {
  GraphQLClient,
  WORKSPACE_ISSUES_QUERY
} from './clients/graphql.js';
import { mapRawToSnapshot,ZenHubClient } from './clients/zenhub.js';
import type {
  InputSchema,
  IssueDurationRecord,
  IssuePipelineSnapshot} from './types.js';
import {
  makeIssueKey,
} from './types.js';
import { humanDuration, msToHours, msToMinutes } from './utils/time.js';

// Fix memory snapshot error on Windows by disabling memory monitoring entirely
process.env.APIFY_MEMORY_MBYTES = '0';

function validateInput(input: unknown): InputSchema {
  if (!input || typeof input !== 'object') throw new Error('Input must be an object');
  const inputObj = input as Record<string, unknown>;
  if (!inputObj.slackWebhookUrl || typeof inputObj.slackWebhookUrl !== 'string') 
    throw new Error('Missing slackWebhookUrl');
  if (!inputObj.zenhubToken || typeof inputObj.zenhubToken !== 'string') throw new Error('Missing zenhubToken');
  const useGraphql = Boolean(inputObj.useGraphql);
  if (useGraphql) {
    if (!Array.isArray(inputObj.workspaceIds) || inputObj.workspaceIds.length === 0)
      throw new Error('workspaceIds must be non-empty array when useGraphql is true');
  } else if (!Array.isArray(inputObj.targets) || inputObj.targets.length === 0)
      throw new Error('targets must be non-empty array');
  if (!Array.isArray(inputObj.targetPipelines) || inputObj.targetPipelines.length === 0)
    throw new Error('targetPipelines must be non-empty array');
  return {
    slackWebhookUrl: inputObj.slackWebhookUrl,
    zenhubToken: inputObj.zenhubToken,
    targets: Array.isArray(inputObj.targets)
      ? inputObj.targets.map((t: unknown) => {
          if (typeof t === 'string') {
            const [owner, name] = t.split('/');
            if (!owner || !name) throw new Error(`Invalid target format: ${t}. Expected owner/name`);
            return { repository: { owner, name } };
          }
          return t as { repository: { owner: string; name: string } };
        })
      : [],
    targetPipelines: inputObj.targetPipelines as string[],
    maxIssues: (inputObj.maxIssues as number | undefined) ?? 100,
    githubToken: inputObj.githubToken as string | undefined,
    strictPipelineTimestamp: (inputObj.strictPipelineTimestamp as boolean | undefined) ?? false,
    useGraphql,
    workspaceIds: inputObj.workspaceIds as string[] | undefined,
    sendEmptyReport: (inputObj.sendEmptyReport as boolean | undefined) ?? true,
  };
}

export async function run(): Promise<void> {
  const rawInput = (await Actor.getInput()) || {};
  const input = validateInput(rawInput);
  const zenClient = new ZenHubClient({ token: input.zenhubToken });
  const ghClient = new GitHubClient({ token: input.githubToken });
  const rawInputObj = rawInput as Record<string, unknown>;
  const gqlClient = input.useGraphql
    ? new GraphQLClient({ 
        endpoint: (rawInputObj.graphqlEndpoint as string | undefined) || 'https://api.zenhub.com/graphql', 
        token: input.zenhubToken 
      })
    : null;
  const nowIso = new Date().toISOString();

  const snapshots: IssuePipelineSnapshot[] = [];
  if (input.useGraphql && input.workspaceIds && input.workspaceIds.length > 0 && gqlClient) {
    for (const wid of input.workspaceIds) {
      let after: string | undefined;
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
        const {nodes} = data.workspace.issues;
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
          let isDraft: boolean | undefined;
          if (node.pullRequest && ghClient) {
            try {
              const prDetails = await ghClient.getPullRequest(repoRef, node.number);
              isDraft = prDetails?.draft;
            } catch (e) {
              log.warning(`Failed to get draft status for PR #${node.number}: ${(e as Error).message}`);
            }
          }
          
          let nodeType: string;
          if (node.pullRequest) {
            nodeType = isDraft ? 'Draft Pull Request' : 'Pull Request';
          } else {
            nodeType = 'Issue';
          }
          log.info(`Issue #${node.number} (${nodeType}, state: ${node.state}) assignees: ${assigneeLogins.length > 0 ? assigneeLogins.join(', ') : 'None'}`);
          
          // Use latestTransferTime from pipelineIssue - this is when the issue was last moved to current pipeline
          let enteredAt: string | undefined = node.pipelineIssue?.latestTransferTime || undefined;
          
          if (enteredAt) {
            log.info(`Issue #${node.number} entered pipeline "${currentPipeline}" at ${enteredAt}`);
          } else {
            log.warning(`No latestTransferTime for issue #${node.number} in pipeline ${currentPipeline}`);
          }
          
          const fallbackEnteredAt = enteredAt || nowIso;
          if (!enteredAt && input.strictPipelineTimestamp) {
            log.debug(`Skipping issue #${node.number} - strict mode and no pipeline transfer timestamp`);
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
            isDraft,
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
      let enteredAt: string | undefined;
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
    
    let typeDisplay: string;
    if (s.isPullRequest) {
      typeDisplay = isDraftPR ? 'Draft Pull Request' : 'Pull Request';
    } else {
      typeDisplay = 'Issue';
    }
    
    let draftDisplay: string;
    if (s.isPullRequest) {
      if (s.isDraft === true) {
        draftDisplay = 'Draft';
      } else if (s.isDraft === false) {
        draftDisplay = 'Ready';
      } else {
        draftDisplay = 'Unknown';
      }
    } else {
      draftDisplay = 'N/A';
    }
    
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
  
  // Log statistics of all tickets in target pipelines - separated by type
  const issues = records.filter(r => !r.isPullRequest);
  const pullRequests = records.filter(r => r.isPullRequest);
  
  if (issues.length > 0) {
    log.info('\n=== ISSUES IN TARGET PIPELINES ===');
    issues.forEach((r) => {
      const durationDays = (r.durationHours / 24).toFixed(1);
      const assigneeInfo = r.assigneesCount > 0 ? r.assigneesDisplay : '⚠️ UNASSIGNED';
      log.info(`📋 #${r.issueNumber} (${r.repo.owner}/${r.repo.name}): ${r.durationHuman} (${durationDays} days) - ${assigneeInfo}`);
      log.info(`   Pipeline: ${r.pipeline} | Entered: ${r.pipelineEnteredAt}`);
      log.info(`   ${r.githubUrl}`);
    });
    log.info('=== END ISSUES ===\n');
  }
  
  if (pullRequests.length > 0) {
    log.info('=== PULL REQUESTS IN TARGET PIPELINES ===');
    pullRequests.forEach((r) => {
      const durationDays = (r.durationHours / 24).toFixed(1);
      const assigneeInfo = r.assigneesCount > 0 ? r.assigneesDisplay : '⚠️ UNASSIGNED';
      const draftInfo = r.isDraft === true ? ' [DRAFT]' : r.isDraft === false ? ' [READY]' : '';
      log.info(`🔀 #${r.issueNumber} (${r.repo.owner}/${r.repo.name}): ${r.durationHuman} (${durationDays} days) - ${assigneeInfo}${draftInfo}`);
      log.info(`   Pipeline: ${r.pipeline} | Entered: ${r.pipelineEnteredAt}`);
      log.info(`   ${r.githubUrl}`);
    });
    log.info('=== END PULL REQUESTS ===\n');
  }
  
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
  const webhookUrl = input.slackWebhookUrl;
  const REVIEW_DEADLINE_DAYS = 3; // Number of days to complete review
  const WARNING_THRESHOLD_DAYS = 5; // Yellow warning threshold
  const URGENT_THRESHOLD_DAYS = 7; // Red urgent threshold
  // Above URGENT_THRESHOLD_DAYS = Critical (fire emoji)
  
  try {
    // Filter only Issues (not Pull Requests), only assigned, and only problematic ones
    const assignedIssues = records.filter(r => {
      const durationDays = r.durationHours / 24;
      return r.assigneesCount > 0 && !r.isPullRequest && durationDays >= REVIEW_DEADLINE_DAYS;
    });
    
    // Check if we should send empty report
    if (assignedIssues.length === 0 && !input.sendEmptyReport) {
      log.info('No issues to report and sendEmptyReport is false - skipping Slack notification');
      return;
    }
    
    log.info('Sending results to Slack webhook...');
    
    // Build main message with assigned issues only
    let textSummary = '';
    
    if (assignedIssues.length > 0) {
      // Find max lengths for padding
      const maxNameLength = Math.max(...assignedIssues.map(r => r.assigneesDisplay.length));
      const maxDurationLength = Math.max(...assignedIssues.map(r => r.durationHuman.length));
      
      log.info(`Preparing Slack message with ${assignedIssues.length} assigned issues:`);
      
      assignedIssues.forEach((r, idx) => {
        log.info(`  #${r.issueNumber}: ${r.durationHuman} (${r.durationHours.toFixed(2)}h, ${(r.durationHours / 24).toFixed(2)} days)`);
        
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
        textSummary += `\nPlease look to your assigned issues and comment in the thread if there's any blocker or reason for the delay.`;

    } else {
      // No issues to report - we only get here if sendEmptyReport is true
      textSummary += `✅ Great work! All reviews are on track. 🎉`;
    }
    
    if (assignedIssues.length > 0) {
    //   textSummary += `\n\n<@U06S5J19SQN>`;
    }

    const payload = {
      text: textSummary
    };
    
    log.info('=== FULL SLACK PAYLOAD ===');
    log.info(JSON.stringify(payload, null, 2));
    log.info('=== END SLACK PAYLOAD ===');
    
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
