// Site Clipper — Crawls a website, clips all pages, converts internal links
// to wikilinks, tracks backlinks, and saves as flat markdown files.
//
// Usage:
//   npx ts-node src/site-clipper.ts <url> [options]
//
// Options:
//   -o, --output <dir>     Output directory (default: ./clippings)
//   -d, --depth <n>        Max crawl depth (default: 3, 0 = unlimited)
//   -c, --concurrency <n>  Max concurrent page fetches (default: 3)
//   --domain <domain>      Override domain for internal link detection
//   -h, --help             Show help

import { parseHTML } from 'linkedom';
import { clip, DocumentParser } from './api';
import { Template } from './types/types';
import { buildVariables, generateFrontmatter, formatPropertyValue } from './utils/shared';
import DefuddleClass from 'defuddle';
import { createMarkdownContent } from 'defuddle/full';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PageInfo {
	url: string;
	slug: string;
	title: string;
	markdown: string;
	internalLinks: string[]; // slugs of pages this page links to
}

interface CrawlState {
	discovered: Set<string>; // URLs discovered but not yet processed
	processed: Map<string, PageInfo>; // URL → PageInfo
	backlinks: Map<string, Set<string>>; // slug → set of slugs that link to it
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Node.js-safe file name sanitization (no navigator dependency). */
function sanitizeFileNameNode(fileName: string): string {
	let sanitized = fileName.replace(/[#|\^[\]]/g, '');
	sanitized = sanitized
		.replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
		.replace(/^\./, '_')
		.replace(/^\.+/, '')
		.trim()
		.slice(0, 245);
	return sanitized.length === 0 ? 'Untitled' : sanitized;
}

/** Convert a URL path to a flat slug for the filename. */
function urlToSlug(url: string): string {
	const parsed = new URL(url);
	let pathname = parsed.pathname;

	// Decode URL-encoded characters (e.g., %C3%9C → Ü)
	try {
		pathname = decodeURIComponent(pathname);
	} catch {
		// If decoding fails, use as-is
	}

	// Remove trailing slash
	if (pathname.endsWith('/') && pathname.length > 1) {
		pathname = pathname.slice(0, -1);
	}

	// Root path → index
	if (pathname === '' || pathname === '/') {
		return 'index';
	}

	// Remove leading slash, replace remaining slashes with dashes
	// Keep Unicode letters and numbers, replace everything else
	const slug = pathname
		.replace(/^\//, '')
		.replace(/\//g, '-')
		.replace(/[^a-zA-Z0-9\u00C0-\u024F\u1E00-\u1EFF-_]/g, '')  // Keep Latin Extended + diacritics
		.toLowerCase();

	return slug || 'index';
}

/** Check if a URL is internal (same domain). */
function isInternalUrl(url: string, baseUrl: URL, domainOverride?: string): boolean {
	try {
		const parsed = new URL(url, baseUrl.href);
		if (domainOverride) {
			return parsed.hostname === domainOverride;
		}
		return parsed.hostname === baseUrl.hostname;
	} catch {
		return false;
	}
}

/** Normalize a URL (remove fragments, query params for dedup). */
function normalizeUrl(url: string, baseUrl: URL): string {
	try {
		const parsed = new URL(url, baseUrl.href);
		// Remove fragment
		parsed.hash = '';
		// Keep query params for uniqueness but normalize
		return parsed.href.replace(/\/$/, '') || parsed.origin;
	} catch {
		return '';
	}
}

/** Extract all links from raw HTML and return internal URLs. */
function extractInternalLinks(html: string, baseUrl: URL, domainOverride?: string): Set<string> {
	const doc = parseHTML(html).document;
	const anchors = doc.querySelectorAll('a[href]');
	const internalUrls = new Set<string>();

	for (const anchor of Array.from(anchors)) {
		const href = anchor.getAttribute('href');
		if (!href) continue;

		// Skip anchors, mailto, tel, javascript
		if (href.startsWith('#') || href.startsWith('mailto:') ||
			href.startsWith('tel:') || href.startsWith('javascript:')) {
			continue;
		}

		const normalized = normalizeUrl(href, baseUrl);
		if (!normalized) continue;

		if (isInternalUrl(normalized, baseUrl, domainOverride)) {
			internalUrls.add(normalized);
		}
	}

	return internalUrls;
}

/** Convert internal markdown links to wikilinks. */
function convertLinksToWikilinks(
	markdown: string,
	processedUrls: Map<string, string>, // normalized URL → slug
	currentUrl: string
): string {
	// Match markdown links: [text](url)
	const linkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;

	return markdown.replace(linkRegex, (_match, text, url) => {
		// Clean the URL (remove fragments, anchors)
		const cleanUrl = url.split('#')[0].split('?')[0].trim();
		if (!cleanUrl) return _match;

		// Resolve relative URLs
		const resolved = normalizeUrl(cleanUrl, new URL(currentUrl));
		if (!resolved) return _match;

		// Check if this is an internal link we've processed
		const slug = processedUrls.get(resolved);
		if (slug) {
			// Use display text if different from slug, otherwise just wikilink
			if (text && text !== slug) {
				return `[[${slug}|${text}]]`;
			}
			return `[[${slug}]]`;
		}

		// Not an internal link we know about, keep as-is
		return _match;
	});
}

/** Create the default wiki-ready template. */
function createDefaultTemplate(): Template {
	return {
		id: 'site-clipper-default',
		name: 'Site Clipper Default',
		behavior: 'create',
		noteNameFormat: '{{title}}',
		path: '',
		noteContentFormat: '{{content}}',
		properties: [
			{ name: 'title', value: '{{title}}', type: 'text' },
			{ name: 'source', value: '{{url}}', type: 'text' },
			{ name: 'created', value: '{{date}}', type: 'text' },
			{ name: 'tags', value: 'clippings', type: 'text' },
		],
		triggers: [],
	};
}

// ---------------------------------------------------------------------------
// linkedom-based DocumentParser
// ---------------------------------------------------------------------------

const linkedomParser: DocumentParser = {
	parseFromString(html: string, _mimeType: string) {
		return parseHTML(html).document;
	},
};

// ---------------------------------------------------------------------------
// Crawler
// ---------------------------------------------------------------------------

async function fetchPage(url: string): Promise<string> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
	}
	return await response.text();
}

async function clipPage(
	html: string,
	url: string,
	template: Template
): Promise<{ title: string; markdown: string }> {
	const doc = linkedomParser.parseFromString(html, 'text/html');
	const documentElement = doc.documentElement || doc;

	const defuddle = new DefuddleClass(documentElement as unknown as Document, { url });
	const defuddleResult = defuddle.parse();

	// Fallback: if defuddle returns empty content, extract from main/article elements
	let contentHtml = defuddleResult.content;
	let title = defuddleResult.title;
	let description = defuddleResult.description;

	if (!contentHtml || contentHtml.trim().length === 0) {
		// Try to extract from <main>, <article>, or first substantial content div
		const mainEl = doc.querySelector('main, article, .page-content, .content, #content');
		if (mainEl) {
			contentHtml = mainEl.innerHTML;
		}
	}

	if (!title || title.trim().length === 0) {
		// Fallback to <title> tag or <h1>
		const titleEl = doc.querySelector('title');
		if (titleEl?.textContent) {
			title = titleEl.textContent.trim();
		} else {
			const h1 = doc.querySelector('h1');
			title = h1?.textContent?.trim() || '';
		}
	}

	if (!description || description.trim().length === 0) {
		// Fallback to meta description
		const metaDesc = doc.querySelector('meta[name="description"], meta[property="og:description"]');
		description = metaDesc?.getAttribute('content') || '';
	}

	const markdownContent = createMarkdownContent(contentHtml, url);

	const variables = buildVariables({
		title,
		author: defuddleResult.author,
		content: markdownContent,
		contentHtml,
		url,
		fullHtml: html,
		description,
		favicon: defuddleResult.favicon,
		image: defuddleResult.image,
		published: defuddleResult.published,
		site: defuddleResult.site,
		language: defuddleResult.language,
		wordCount: defuddleResult.wordCount,
		schemaOrgData: defuddleResult.schemaOrgData,
		metaTags: defuddleResult.metaTags,
		extractedContent: defuddleResult.variables,
	});

	const compile = (text: string) => {
		// Simple variable replacement for site-clipper (no async selectors/prompts)
		let result = text;
		for (const [key, value] of Object.entries(variables)) {
			result = result.split(key).join(value);
		}
		return Promise.resolve(result);
	};

	const compiledNoteName = await compile(template.noteNameFormat);
	const finalTitle = sanitizeFileNameNode(compiledNoteName) || title || 'Untitled';

	const compiledProperties = await Promise.all(
		template.properties.map(async (prop) => {
			let value = await compile(prop.value);
			const propType = prop.type || 'text';
			value = formatPropertyValue(value, propType, prop.value);
			return { name: prop.name, value, type: prop.type };
		})
	);

	const typeMap: Record<string, string> = {};
	for (const prop of template.properties) {
		if (prop.type) typeMap[prop.name] = prop.type;
	}

	const frontmatter = generateFrontmatter(compiledProperties, typeMap);
	const content = await compile(template.noteContentFormat);
	const fullContent = frontmatter ? frontmatter + content : content;

	return { title: finalTitle, markdown: fullContent };
}

// ---------------------------------------------------------------------------
// Main crawl + clip logic
// ---------------------------------------------------------------------------

async function crawlAndClip(
	startUrl: string,
	outputDir: string,
	maxDepth: number,
	concurrency: number,
	domainOverride?: string
): Promise<void> {
	const baseUrl = new URL(startUrl);
	const template = createDefaultTemplate();
	const state: CrawlState = {
		discovered: new Set([startUrl.replace(/\/$/, '')]),
		processed: new Map(),
		backlinks: new Map(),
	};

	console.log(`🕷️  Starting crawl from: ${startUrl}`);
	console.log(`📁 Output directory: ${outputDir}`);
	console.log(`🔗 Max depth: ${maxDepth || 'unlimited'}`);
	console.log(`⚡ Concurrency: ${concurrency}`);
	console.log('');

	// Create output directory
	if (!fs.existsSync(outputDir)) {
		fs.mkdirSync(outputDir, { recursive: true });
	}

	// Track depth: URL → depth level
	const depthMap = new Map<string, number>();
	depthMap.set(startUrl.replace(/\/$/, ''), 0);

	// Process queue with concurrency control
	async function processQueue(): Promise<void> {
		const queue = Array.from(state.discovered);
		state.discovered.clear();

		// Process in batches of `concurrency`
		for (let i = 0; i < queue.length; i += concurrency) {
			const batch = queue.slice(i, i + concurrency);
			const promises = batch.map(async (url) => {
				const currentDepth = depthMap.get(url) ?? 0;

				// Skip if already processed
				if (state.processed.has(url)) return;

				try {
					console.log(`📄 [${currentDepth}] Fetching: ${url}`);
					const html = await fetchPage(url);
					const slug = urlToSlug(url);

					// Extract internal links before clipping (from raw HTML)
					const internalUrls = extractInternalLinks(html, baseUrl, domainOverride);

					// Clip the page
					const { title, markdown } = await clipPage(html, url, template);

					// Track backlinks
					for (const linkedUrl of internalUrls) {
						const linkedSlug = urlToSlug(linkedUrl);
						if (!state.backlinks.has(linkedSlug)) {
							state.backlinks.set(linkedSlug, new Set());
						}
						state.backlinks.get(linkedSlug)!.add(slug);
					}

					// Store page info (wikilinks will be converted after all pages are processed)
					state.processed.set(url, {
						url,
						slug,
						title,
						markdown,
						internalLinks: Array.from(internalUrls).map(u => urlToSlug(u)),
					});

					// Add newly discovered URLs to next round
					const nextDepth = currentDepth + 1;
					for (const linkedUrl of internalUrls) {
						if (!state.processed.has(linkedUrl) && !state.discovered.has(linkedUrl)) {
							if (maxDepth === 0 || nextDepth <= maxDepth) {
								state.discovered.add(linkedUrl);
								depthMap.set(linkedUrl, nextDepth);
							}
						}
					}

					console.log(`   ✅ Clipped: ${slug} (${title})`);
				} catch (err: any) {
					console.error(`   ❌ Failed: ${url} — ${err.message}`);
				}
			});

			await Promise.all(promises);
		}

		// If there are more URLs to process, continue
		if (state.discovered.size > 0) {
			await processQueue();
		}
	}

	await processQueue();

	// -----------------------------------------------------------------------
	// Post-processing: convert links to wikilinks and add backlinks
	// -----------------------------------------------------------------------
	console.log('');
	console.log(`📝 Post-processing ${state.processed.size} pages...`);

	// Build URL → slug map for wikilink conversion
	const urlToSlugMap = new Map<string, string>();
	for (const [url, info] of state.processed) {
		urlToSlugMap.set(url, info.slug);
	}

	for (const [url, info] of state.processed) {
		// Convert internal links to wikilinks
		let content = convertLinksToWikilinks(info.markdown, urlToSlugMap, url);

		// Add backlinks to frontmatter
		const backlinks = state.backlinks.get(info.slug);
		if (backlinks && backlinks.size > 0) {
			const backlinkList = Array.from(backlinks).sort();
			const backlinkYaml = backlinkList.map(slug => `  - "${slug}"`).join('\n');
			// Insert backlinks after the opening ---
			content = content.replace(/^---\n/, `---\nbacklinks:\n${backlinkYaml}\n`);
		}

		// Write file
		const filePath = path.join(outputDir, `${info.slug}.md`);
		fs.writeFileSync(filePath, content, 'utf-8');
		console.log(`   💾 Saved: ${info.slug}.md`);
	}

	// -----------------------------------------------------------------------
	// Summary
	// -----------------------------------------------------------------------
	console.log('');
	console.log('✅ Done!');
	console.log(`   Pages clipped: ${state.processed.size}`);
	console.log(`   Output directory: ${outputDir}`);
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function printHelp(): void {
	console.log(`
Usage: site-clipper <url> [options]

Crawl a website and clip all pages as markdown files with wikilinks.

Options:
  -o, --output <dir>       Output directory (default: ./clippings)
  -d, --depth <n>          Max crawl depth (default: 3, 0 = unlimited)
  -c, --concurrency <n>    Max concurrent page fetches (default: 3)
  --domain <domain>        Override domain for internal link detection
  -h, --help               Show this help message

Examples:
  npx ts-node src/site-clipper.ts https://example.com
  npx ts-node src/site-clipper.ts https://example.com -o ./my-wiki -d 2
  npx ts-node src/site-clipper.ts https://example.com --domain example.com
`.trim());
}

interface SiteClipperArgs {
	url: string;
	outputDir: string;
	maxDepth: number;
	concurrency: number;
	domainOverride?: string;
}

function parseArgs(argv: string[]): SiteClipperArgs {
	const args = argv.slice(2);
	let url = '';
	let outputDir = './clippings';
	let maxDepth = 3;
	let concurrency = 3;
	let domainOverride: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case '-h':
			case '--help':
				printHelp();
				process.exit(0);
				break;
			case '-o':
			case '--output':
				outputDir = args[++i];
				break;
			case '-d':
			case '--depth':
				maxDepth = parseInt(args[++i], 10);
				break;
			case '-c':
			case '--concurrency':
				concurrency = parseInt(args[++i], 10);
				break;
			case '--domain':
				domainOverride = args[++i];
				break;
			default:
				if (!arg.startsWith('-') && !url) {
					url = arg;
				} else {
					console.error(`Unknown option: ${arg}`);
					printHelp();
					process.exit(1);
				}
		}
	}

	if (!url) {
		console.error('Error: URL is required');
		printHelp();
		process.exit(1);
	}

	return { url, outputDir, maxDepth, concurrency, domainOverride };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const args = parseArgs(process.argv);
	await crawlAndClip(args.url, args.outputDir, args.maxDepth, args.concurrency, args.domainOverride);
}

main().catch(err => {
	console.error(err.message || err);
	process.exit(1);
});
