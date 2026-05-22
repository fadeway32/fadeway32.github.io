const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const POSTS_DIR = path.join(ROOT, 'source', '_posts');
const THEME_COVERS_DIR = path.join(ROOT, 'themes', 'LiveForCode', 'source', 'image', 'home-covers');
const PUBLIC_COVERS_DIR = path.join(ROOT, 'public', 'image', 'home-covers');
const FALLBACK_FILE = path.join(ROOT, 'themes', 'LiveForCode', 'source', 'image', 'header', 'home.jpg');
const PER_PAGE = 15;
const CONCURRENCY = 4;
const REQUEST_TIMEOUT = 20000;
const REFRESH_MODE = (process.env.HOME_COVER_REFRESH_MODE || 'all').toLowerCase();
const COVER_APIS = [
    'https://picapi.pai.al/api/1080P.php',
    'https://picapi.pai.al/api/scenery.php',
    'https://picapi.pai.al/api/Therealworld2.php',
    'https://picapi.pai.al/api/Therealworld1080P2.php'
];

function walkMarkdownFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) return walkMarkdownFiles(fullPath);
        return /\.md$/i.test(entry.name) ? [fullPath] : [];
    });
}

function ensureDir(dir) {
    fs.mkdirSync(dir, {recursive: true});
}

function cleanupStaleCoverPages(maxPage) {
    if (!fs.existsSync(THEME_COVERS_DIR)) return;

    for (const entry of fs.readdirSync(THEME_COVERS_DIR, {withFileTypes: true})) {
        if (!entry.isDirectory()) continue;
        const match = /^page-(\d+)$/.exec(entry.name);
        if (!match) continue;
        const page = parseInt(match[1], 10);
        if (page > maxPage) {
            fs.rmSync(path.join(THEME_COVERS_DIR, entry.name), {recursive: true, force: true});
        }
    }
}

function copyDir(source, target) {
    ensureDir(target);
    for (const entry of fs.readdirSync(source, {withFileTypes: true})) {
        const sourcePath = path.join(source, entry.name);
        const targetPath = path.join(target, entry.name);
        if (entry.isDirectory()) {
            copyDir(sourcePath, targetPath);
        } else {
            fs.copyFileSync(sourcePath, targetPath);
        }
    }
}

function buildUrl(page, slot) {
    const endpoint = COVER_APIS[(page + slot + Date.now()) % COVER_APIS.length];
    const separator = endpoint.includes('?') ? '&' : '?';
    return `${endpoint}${separator}lfc=${page}-${slot}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function requestBuffer(url, redirects = 0) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https:') ? https : http;
        const request = client.get(url, {
            headers: {
                'User-Agent': 'LiveForCodeCoverRefresh/1.0',
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
            },
            timeout: REQUEST_TIMEOUT
        }, (response) => {
            const location = response.headers.location;
            if ([301, 302, 303, 307, 308].includes(response.statusCode) && location && redirects < 5) {
                response.resume();
                const nextUrl = new URL(location, url).toString();
                requestBuffer(nextUrl, redirects + 1).then(resolve, reject);
                return;
            }

            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error(`HTTP ${response.statusCode}`));
                return;
            }

            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
                const buffer = Buffer.concat(chunks);
                const contentType = String(response.headers['content-type'] || '');
                if (!contentType.startsWith('image/') || buffer.length < 1024) {
                    reject(new Error(`Invalid image response: ${contentType || 'unknown'}`));
                    return;
                }
                resolve(buffer);
            });
        });

        request.on('timeout', () => {
            request.destroy(new Error('Request timed out'));
        });
        request.on('error', reject);
    });
}

async function refreshCover(page, slot) {
    const pageDir = path.join(THEME_COVERS_DIR, `page-${page}`);
    const filePath = path.join(pageDir, `${String(slot).padStart(2, '0')}.jpg`);
    ensureDir(pageDir);

    if (REFRESH_MODE === 'missing' && fs.existsSync(filePath) && fs.statSync(filePath).size > 1024) {
        return {page, slot, path: filePath, skipped: true};
    }

    try {
        const buffer = await requestBuffer(buildUrl(page, slot));
        fs.writeFileSync(filePath, buffer);
        return {page, slot, path: filePath, downloaded: true};
    } catch (error) {
        if (!fs.existsSync(filePath) || fs.statSync(filePath).size <= 1024) {
            fs.copyFileSync(FALLBACK_FILE, filePath);
        }
        return {page, slot, path: filePath, fallback: true, error: error.message};
    }
}

async function runQueue(tasks) {
    const results = [];
    let cursor = 0;

    async function worker() {
        while (cursor < tasks.length) {
            const index = cursor++;
            results[index] = await tasks[index]();
        }
    }

    await Promise.all(Array.from({length: Math.min(CONCURRENCY, tasks.length)}, worker));
    return results;
}

function writeManifest(totalPages) {
    const pages = {};
    for (let page = 1; page <= totalPages; page++) {
        pages[String(page)] = [];
        for (let slot = 1; slot <= PER_PAGE; slot++) {
            pages[String(page)].push(`/image/home-covers/page-${page}/${String(slot).padStart(2, '0')}.jpg`);
        }
    }

    const manifest = {
        updatedAt: new Date().toISOString(),
        perPage: PER_PAGE,
        pages
    };

    fs.writeFileSync(path.join(THEME_COVERS_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return manifest;
}

function mirrorToPublic() {
    fs.rmSync(PUBLIC_COVERS_DIR, {recursive: true, force: true});
    copyDir(THEME_COVERS_DIR, PUBLIC_COVERS_DIR);
}

async function main() {
    const postCount = walkMarkdownFiles(POSTS_DIR).length;
    const totalPages = Math.max(1, Math.ceil(postCount / PER_PAGE));
    const tasks = [];

    ensureDir(THEME_COVERS_DIR);
    cleanupStaleCoverPages(totalPages);
    for (let page = 1; page <= totalPages; page++) {
        for (let slot = 1; slot <= PER_PAGE; slot++) {
            tasks.push(() => refreshCover(page, slot));
        }
    }

    const startedAt = Date.now();
    const results = await runQueue(tasks);
    const manifest = writeManifest(totalPages);
    mirrorToPublic();

    const downloaded = results.filter((item) => item.downloaded).length;
    const fallback = results.filter((item) => item.fallback).length;
    const skipped = results.filter((item) => item.skipped).length;
    console.log(`Home covers ready: ${postCount} posts, ${totalPages} pages, ${totalPages * PER_PAGE} images.`);
    console.log(`Downloaded: ${downloaded}, fallback/existing: ${fallback}, skipped: ${skipped}.`);
    console.log(`Manifest: ${manifest.updatedAt}`);
    console.log(`Elapsed: ${Math.round((Date.now() - startedAt) / 1000)}s`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
