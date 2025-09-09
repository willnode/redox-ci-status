import { serve } from 'bun';

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const CACHE_DURATION_MS = 1 * 60 * 60 * 1000; // 1 hour
const GITLAB_URL = process.env.GITLAB_URL || 'https://gitlab.redox-os.org';
const GITLAB_PRIVATE_TOKEN = process.env.GITLAB_PRIVATE_TOKEN; // Optional, but recommended for higher rate limits
const ARTIFACT_URL = 'https://static.redox-os.org/pkg/';
const ARTIFACT_STALE_HOURS = 48;

// Hardcoded list of projects to track
const PROJECTS_TO_TRACK = [
    'redox-os/redox',
    'redox-os/relibc',
    'redox-os/cookbook',
    'redox-os/installer',
    'redox-os/pkgutils',
    'redox-os/kernel',
    'redox-os/drivers',
    'redox-os/base',
    'redox-os/redoxfs',
    'redox-os/bootloader',
    'redox-os/acid',
    'redox-os/redoxer',
    'redox-os/orbital',
    'redox-os/orbutils',
    'redox-os/extrautils',
    'redox-os/book',
    'redox-os/website',
];

// --- IN-MEMORY CACHE ---
let cachedGitlabData: ProjectInfo[] | null = null;
let cachedArtifactData: ArtifactInfo[] | null = null;
let lastCacheTime = 0;

interface ProjectInfo {
    name: string;
    url: string;
    status: string;
    commit: {
        message: string;
        author: string;
        date: string;
    } | null;
}

interface ArtifactInfo {
    name: string;
    url: string;
    lastModified: string;
    isStale: boolean;
}

/**
 * Fetches the latest repository, pipeline, and commit data from GitLab.
 * @returns {Promise<ProjectInfo[]>} A promise that resolves to an array of project information.
 */
async function fetchGitLabData(): Promise<ProjectInfo[]> {
    if (!GITLAB_PRIVATE_TOKEN) {
        console.warn("GITLAB_PRIVATE_TOKEN is not set. API requests will be unauthenticated and may be rate-limited.");
    }

    const headers = GITLAB_PRIVATE_TOKEN ? { 'PRIVATE-TOKEN': GITLAB_PRIVATE_TOKEN } : {};
    console.log(`Fetching data for ${PROJECTS_TO_TRACK.length} hardcoded projects...`);

    // For each project path, fetch its details, latest pipeline, and commit status
    const projectPromises = PROJECTS_TO_TRACK.map(async (projectPath) => {
        try {
            const encodedProjectPath = encodeURIComponent(projectPath);

            // 1. Fetch the main project details to get its ID
            const projectResponse = await fetch(`${GITLAB_URL}/api/v4/projects/${encodedProjectPath}`, { headers });
            if (!projectResponse.ok) {
                console.error(`Failed to fetch project ${projectPath}: ${projectResponse.status} ${projectResponse.statusText}`);
                return null;
            }
            const project = await projectResponse.json() as any;

            // 2. Fetch latest pipeline
            const pipelineResponse = await fetch(`${GITLAB_URL}/api/v4/projects/${project.id}/pipelines?per_page=1&page=1&ref=master`, { headers });
            const pipelines = await pipelineResponse.json();
            const latestPipeline = pipelines?.[0];

            // 3. Fetch latest commit
            const commitResponse = await fetch(`${GITLAB_URL}/api/v4/projects/${project.id}/repository/commits?per_page=1&page=1`, { headers });
            const commits = await commitResponse.json();
            const latestCommit = commits?.[0];

            return {
                name: project.name_with_namespace,
                url: project.web_url,
                status: latestPipeline?.status || 'no-pipelines',
		pipelineUrl: latestPipeline?.web_url,
		id: project.id,
                commit: latestCommit ? {
                    message: latestCommit.title, author: latestCommit.author_name, date: latestCommit.created_at, // Keep as ISO string for parsing later
                } : null,
            };
        } catch (error) {
            console.error(`Failed to process project ${projectPath}:`, error);
            return null; // Return null for failed projects
        }
    });

    const results = await Promise.all(projectPromises);
    return results.filter((p): p is ProjectInfo => p !== null); // Filter out any projects that failed
}

/**
 * Fetches and parses the artifact server directory listing.
 * @returns {Promise<ArtifactInfo[]>} A promise that resolves to an array of artifact information.
 */
async function fetchArtifactStatus(): Promise<ArtifactInfo[]> {
    console.log("Fetching artifact status from Apache server index...");
    try {
        const response = await fetch(ARTIFACT_URL);
        if (!response.ok) {
            throw new Error(`Failed to fetch artifact page: ${response.status} ${response.statusText}`);
        }
        const html = await response.text();
        const results: ArtifactInfo[] = [];
        
        // Regex to find directory rows and extract name and date
        const regex = /<img src="\/icons\/folder.gif".*?<a href="([^"]+)">[^<]+<\/a>.*?<td align="right">([\d\-]{10} [\d:]{5})\s+<\/td>/g;
        let match;

        while ((match = regex.exec(html)) !== null) {
            const name = match[1];
            const dateString = match[2];
            const lastModifiedDate = new Date(dateString);
            const hoursDiff = (Date.now() - lastModifiedDate.getTime()) / (1000 * 60 * 60);

            results.push({
                name,
                url: `${ARTIFACT_URL}${name}`,
                lastModified: lastModifiedDate.toISOString(),
                isStale: hoursDiff > ARTIFACT_STALE_HOURS,
            });
        }
        return results;
    } catch (error) {
        console.error("Failed to fetch or parse artifact data:", error);
        return []; // Return empty array on failure
    }
}


/**
 * Helper function for humanize. Formats the time value and unit.
 * @param {number} value - The numeric value of the time.
 * @param {string} unit - The unit of time (e.g., 'seconds', 'minutes').
 * @returns {string} A formatted string like "5 minutes ago".
 */
function _hmi(value: number, unit: string): string {
    const rounded = Math.round(value);
    const plural = rounded === 1 ? '' : 's';
    return `${rounded} ${unit}${plural} ago`;
}

/**
 * Converts a time duration in milliseconds to a human-readable string.
 * @param {number} time - The time duration in milliseconds.
 * @returns {string} A human-readable relative time string.
 */
export function humanize(time: number) {
    time /= 1000; // convert to seconds
    if (time < 60) {
        return _hmi(time, 'second');
    }
    if (time < 3600) {
        return _hmi(time / 60, 'minute');
    }
    if (time < 86400) {
        return _hmi(time / 3600, 'hour');
    }
    if (time < 604800) {
        return _hmi(time / 86400, 'day');
    }
    if (time < 2592000) {
        return _hmi(time / 604800, 'week');
    }
    if (time < 31536000) {
        return _hmi(time / 2592000, 'month');
    }
    return _hmi(time / 31536000, 'year');
}


/**
 * Generates the status badge HTML based on the CI status string.
 * @param {string} status - The CI status from GitLab.
 * @returns {string} The HTML for the status badge.
 */
function getStatusBadge(status: string, pipelineUrl: string): string {
    const statusLower = status.toLowerCase();
    let color = '#888'; // Default grey
    let text = status;

    switch (statusLower) {
        case 'success':
            color = '#28a745'; // Green
            break;
        case 'failed':
            color = '#dc3545'; // Red
            break;
        case 'running':
            color = '#007bff'; // Blue
            break;
        case 'pending':
            color = '#ffc107'; // Yellow
            break;
        case 'canceled':
            color = '#6c757d'; // Grey
            break;
    }
    
    return `<a href="${pipelineUrl || '#'}" target="_blank" rel="noopener noreferrer" class="status" style="background-color: ${color};">${text}</a>`;
}

/**
 * Generates a status badge for an artifact.
 * @param {boolean} isStale - Whether the artifact is considered stale.
 * @returns {string} The HTML for the status badge.
 */
function getArtifactStatusBadge(isStale: boolean): string {
    const color = isStale ? '#dc3545' : '#28a745';
    const text = isStale ? `Stale (> ${ARTIFACT_STALE_HOURS}h)` : 'OK';
    return `<span class="status" style="background-color: ${color};">${text}</span>`;
}


/**
 * Generates the full HTML page to display the project statuses.
 * @param {ProjectInfo[]} gitlabData - The array of project data to render.
 * @param {ArtifactInfo[]} artifactData - The array of artifact data to render.
 * @returns {string} A complete HTML document as a string.
 */
function generateHtml(gitlabData: ProjectInfo[], artifactData: ArtifactInfo[]): string {
    const gitlabTableRows = gitlabData.map(repo => `
        <tr>
            <td><a href="${repo.url}" data-id="${repo.id}" target="_blank" rel="noopener noreferrer">${repo.name}</a></td>
            <td>${getStatusBadge(repo.status, repo.pipelineUrl)}</td>
            <td class="commit-msg">${repo.commit?.message || 'N/A'}</td>
            <td>${repo.commit?.author || 'N/A'}</td>
            <td>${repo.commit?.date ? humanize(Date.now() - new Date(repo.commit.date).getTime()) : 'N/A'}</td>
        </tr>
    `).join('');

    const artifactTableRows = artifactData.map(artifact => `
         <tr>
            <td><a href="${artifact.url}" target="_blank" rel="noopener noreferrer">${artifact.name}</a></td>
            <td>${getArtifactStatusBadge(artifact.isStale)}</td>
            <td>${humanize(Date.now() - new Date(artifact.lastModified).getTime())}</td>
        </tr>
    `).join('');

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Redox OS Dashboard</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background-color: #f8f9fa;
            color: #333;
            margin: 0;
            padding: 2rem;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto 2rem auto;
            background-color: #fff;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.08);
            overflow: hidden;
        }
        h1, h2 {
            padding: 1.5rem;
            margin: 0;
            color: white;
            border-bottom: 1px solid #ddd;
        }
        h1 {
            text-align: center;
            background-color: #4a4a4a;
        }
        h2 {
            background-color: #6c757d;
            font-size: 1.5em;
        }
        table {
            width: 100%;
            border-collapse: collapse;
        }
        th, td {
            padding: 1rem;
            text-align: left;
            border-bottom: 1px solid #dee2e6;
        }
        th {
            background-color: #f1f3f5;
            font-weight: 600;
        }
        tr:last-child td {
            border-bottom: none;
        }
        tr:hover {
            background-color: #f8f9fa;
        }
        a {
            color: #0052cc;
            text-decoration: none;
            font-weight: 500;
        }
        a:hover {
            text-decoration: underline;
        }
        .status {
            display: inline-block;
            padding: 0.3em 0.6em;
            font-size: 0.8em;
            font-weight: 700;
            line-height: 1;
            color: #fff;
            text-align: center;
            white-space: nowrap;
            vertical-align: baseline;
            border-radius: 0.25rem;
            text-transform: capitalize;
        }
        .commit-msg {
            max-width: 300px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .footer {
            padding: 1rem;
            text-align: center;
            font-size: 0.9em;
            color: #888;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Redox OS Dashboard</h1>
        
        <h2>GitLab CI Status</h2>
        <table>
            <thead>
                <tr>
                    <th>Repository</th>
                    <th>Latest CI Status</th>
                    <th>Latest Commit</th>
                    <th>Author</th>
                    <th>Date</th>
                </tr>
            </thead>
            <tbody>
                ${gitlabTableRows}
            </tbody>
        </table>
    </div>

    <div class="container">
        <h2>Jenkins Artifacts</h2>
        <table>
            <thead>
                <tr>
                    <th>Artifact Target</th>
                    <th>Status</th>
                    <th>Last Updated</th>
                </tr>
            </thead>
            <tbody>
                ${artifactTableRows}
            </tbody>
        </table>
    </div>
    
    <div class="footer">
        Last updated: ${new Date(lastCacheTime).toLocaleString()} (${humanize(Date.now() - new Date(lastCacheTime).getTime())}) &mdash;
        <a href="https://github.com/willnode/redox-ci-status" target="_blank">Source code</a>
    </div>
</body>
</html>`;
}

// --- BUN HTTP SERVER ---
serve({
    port: PORT,
    async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== '/') {
            return new Response("Not Found", { status: 404 });
        }

        const now = Date.now();
        
        // Check if cache is still valid
        if (cachedGitlabData && cachedArtifactData && (now - lastCacheTime < CACHE_DURATION_MS)) {
            console.log("Serving response from cache.");
        } else {
            console.log("Cache expired or empty. Fetching new data...");
            try {
                // Fetch both GitLab and artifact data in parallel
                const [gitlabData, artifactData] = await Promise.all([
                    fetchGitLabData(),
                    fetchArtifactStatus()
                ]);

                cachedGitlabData = gitlabData;
                cachedArtifactData = artifactData;
                lastCacheTime = now;
                console.log("Successfully fetched and cached new data.");
            } catch (error: any) {
                console.error("Failed to fetch data:", error);
                const errorHtml = `<h1>Error</h1><p>Could not fetch data. Please check the server logs and your environment variables.</p><pre>${error.message}</pre>`;
                return new Response(errorHtml, {
                    status: 500,
                    headers: { 'Content-Type': 'text/html; charset=utf-8' },
                });
            }
        }
        
        const html = generateHtml(cachedGitlabData || [], cachedArtifactData || []);
        return new Response(html, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
    },
});


console.log(`🦊 Redox OS Dashboard is running at http://localhost:${PORT}`);

