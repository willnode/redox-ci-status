import { serve } from 'bun';

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const CACHE_DURATION_MS = 1 * 60 * 60 * 1000; // 12 hours
const GITLAB_URL = process.env.GITLAB_URL || 'https://gitlab.redox-os.org';
const GITLAB_PRIVATE_TOKEN = process.env.GITLAB_PRIVATE_TOKEN; // Optional, but recommended for higher rate limits

// Hardcoded list of projects to track
const PROJECTS_TO_TRACK = [
    'redox-os/redox',
    'redox-os/relibc',
    'redox-os/cookbook',
    'redox-os/installer',
    'redox-os/kernel',
    'redox-os/drivers',
    'redox-os/redoxfs',
    'redox-os/bootloader',
    'redox-os/redoxer',
    'redox-os/acid',
];

// --- IN-MEMORY CACHE ---
let cachedData: any[] | null = null;
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
                // If a specific project is not found or access is denied, log it and continue
                console.error(`Failed to fetch project ${projectPath}: ${projectResponse.status} ${projectResponse.statusText}`);
                return null;
            }
            const project = await projectResponse.json() as any;

            // 2. Fetch latest pipeline
            const pipelineResponse = await fetch(`${GITLAB_URL}/api/v4/projects/${project.id}/pipelines?per_page=1&page=1`, { headers });
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
                commit: latestCommit ? {
                    message: latestCommit.title,
                    author: latestCommit.author_name,
                    date: new Date(latestCommit.created_at).toLocaleString(),
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
 * Generates the status badge HTML based on the CI status string.
 * @param {string} status - The CI status from GitLab.
 * @returns {string} The HTML for the status badge.
 */
function getStatusBadge(status: string): string {
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
    
    return `<span class="status" style="background-color: ${color};">${text}</span>`;
}


/**
 * Generates the full HTML page to display the project statuses.
 * @param {ProjectInfo[]} data - The array of project data to render.
 * @returns {string} A complete HTML document as a string.
 */
function generateHtml(data: ProjectInfo[]): string {
    const tableRows = data.map(repo => `
        <tr>
            <td><a href="${repo.url}" target="_blank" rel="noopener noreferrer">${repo.name}</a></td>
            <td>${getStatusBadge(repo.status)}</td>
            <td class="commit-msg">${repo.commit?.message || 'N/A'}</td>
            <td>${repo.commit?.author || 'N/A'}</td>
            <td>${repo.commit?.date || 'N/A'}</td>
        </tr>
    `).join('');

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>GitLab CI Dashboard</title>
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
            margin: auto;
            background-color: #fff;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.08);
            overflow: hidden;
        }
        h1 {
            text-align: center;
            padding: 1.5rem;
            margin: 0;
            background-color: #4a4a4a;
            color: white;
            border-bottom: 1px solid #ddd;
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
        <h1>GitLab CI Status</h1>
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
                ${tableRows}
            </tbody>
        </table>
        <div class="footer">
            Last updated: ${new Date().toLocaleString()}
        </div>
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
        if (cachedData && (now - lastCacheTime < CACHE_DURATION_MS)) {
            console.log("Serving response from cache.");
        } else {
            console.log("Cache expired or empty. Fetching new data from GitLab...");
            try {
                cachedData = await fetchGitLabData();
                lastCacheTime = now;
                console.log("Successfully fetched and cached new data.");
            } catch (error: any) {
                console.error("Failed to fetch data from GitLab:", error);
                const errorHtml = `<h1>Error</h1><p>Could not fetch data from GitLab. Please check the server logs and your environment variables.</p><pre>${error.message}</pre>`;
                return new Response(errorHtml, {
                    status: 500,
                    headers: { 'Content-Type': 'text/html; charset=utf-8' },
                });
            }
        }
        
        const html = generateHtml(cachedData || []);
        return new Response(html, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
    },
});


console.log(`🦊 GitLab CI Dashboard is running at http://localhost:${PORT}`);


