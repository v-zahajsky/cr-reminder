// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/)
import { Actor, log } from 'apify';
import { run } from './runner.js';

// Disable memory snapshots to avoid wmic.exe errors on Windows
process.env.APIFY_DISABLE_OUTDATED_WARNING = '1';
process.env.APIFY_MEMORY_MBYTES = '0';
process.env.APIFY_SYSTEM_INFO_INTERVAL_MILLIS = '0';

// Crawlee - web scraping and browser automation library (Read more at https://crawlee.dev)
// import { CheerioCrawler } from 'crawlee';

// this is ESM project, and as such, it requires you to specify extensions in your relative imports
// read more about this here: https://nodejs.org/docs/latest-v18.x/api/esm.html#mandatory-file-extensions
// note that we need to use `.js` even when inside TS files
// import { router } from './routes.js';

// The init() call configures the Actor for its environment. It's recommended to start every Actor with an init()
await Actor.init({
	systemInfoIntervalMillis: 0
});

try {
	log.info('Starting Review/QA duration Actor run');
	await run();
	log.info('Run finished successfully');
} catch (err) {
	log.exception(err as Error, 'Actor run failed');
	throw err; // ensure non-zero exit on platform
}

// Gracefully exit the Actor process. It's recommended to quit all Actors with an exit()
await Actor.exit();
