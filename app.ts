import { serve } from 'bun';
import { generateHtml } from './view';

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const CACHE_DURATION_MS = 1 * 60 * 60 * 1000; // 1 hour
const GITLAB_URL = process.env.GITLAB_URL || 'https://gitlab.redox-os.org';
const GITLAB_PRIVATE_TOKEN = process.env.GITLAB_PRIVATE_TOKEN; // Optional, but recommended for higher rate limits
const ARTIFACT_PKG_URL = 'https://static.redox-os.org/pkg/';
const ARTIFACT_IMG_URL = 'https://static.redox-os.org/img/';
export const ARTIFACT_STALE_HOURS = 48;

// Hardcoded list of projects to track
const PROJECTS_TO_TRACK = [
    // critical
    { path: 'redox-os/redox', branch: 'master', pkg: 'redox' },
    { path: 'redox-os/relibc', branch: 'master', pkg: 'relibc' },
    { path: 'redox-os/base', branch: 'master', pkg: 'base' },
    { path: 'redox-os/bootloader', branch: 'master', pkg: 'bootloader' },
    { path: 'redox-os/kernel', branch: 'master', pkg: 'kernel' },
    { path: 'redox-os/redoxfs', branch: 'master', pkg: 'redoxfs' },
    // non-critical
    { path: 'redox-os/acid', branch: 'master', pkg: 'acid' },
    { path: 'redox-os/coreutils', branch: 'master', pkg: 'coreutils' },
    { path: 'redox-os/extrautils', branch: 'master', pkg: 'extrautils' },
    { path: 'redox-os/installer', branch: 'master', pkg: 'installer' },
    { path: 'redox-os/orbital', branch: 'master', pkg: 'orbital' },
    { path: 'redox-os/orbutils', branch: 'master', pkg: 'orbutils' },
    { path: 'redox-os/pkgutils', branch: 'master', pkg: 'pkgutils' },
    { path: 'redox-os/redoxer', branch: 'master', pkg: 'redoxer' },
    // website
    { path: 'redox-os/book', branch: 'master', pkg: 'book' },
    { path: 'redox-os/website', branch: 'master', pkg: 'website' },
];

// --- IN-MEMORY CACHE ---
let cachedGitlabData: ProjectInfo[] | null = null;
let cachedArtifactPkgData: ArtifactInfo[] | null = null;
let cachedArtifactImgData: ArtifactInfo[] | null = null;
export let lastCacheTime = 0;

export interface ProjectInfo {
    id: string;
    name: string;
    url: string;
    status: string;
    pipelineUrl: string;
    commit: {
        message: string;
        author: string;
        date: string;
    } | null;
}

export interface ArtifactInfo {
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

    const headers: Bun.HeadersInit = GITLAB_PRIVATE_TOKEN ? { 'PRIVATE-TOKEN': GITLAB_PRIVATE_TOKEN } : {};
    console.log(`Fetching data for ${PROJECTS_TO_TRACK.length} hardcoded projects...`);

    // For each project path, fetch its details, latest pipeline, and commit status
    const projectPromises: Promise<null | ProjectInfo>[] = PROJECTS_TO_TRACK.map(async ({ path, branch }) => {
        try {
            const encodedProjectPath = encodeURIComponent(path);

            // 1. Fetch the main project details to get its ID
            const projectResponse = await fetch(`${GITLAB_URL}/api/v4/projects/${encodedProjectPath}`, { headers });
            if (!projectResponse.ok) {
                console.error(`Failed to fetch project ${path}: ${projectResponse.status} ${projectResponse.statusText}`);
                return null;
            }
            const project = await projectResponse.json() as any;

            // 2. Fetch latest pipeline
            const pipelineResponse = await fetch(`${GITLAB_URL}/api/v4/projects/${project.id}/pipelines?per_page=1&page=1&ref=${branch}`, { headers });
            const pipelines = await pipelineResponse.json() as any;
            const latestPipeline = pipelines?.[0];

            // 3. Fetch latest commit
            const commitResponse = await fetch(`${GITLAB_URL}/api/v4/projects/${project.id}/repository/commits?per_page=1&page=1`, { headers });
            const commits = await commitResponse.json() as any;
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
            console.error(`Failed to process project ${path}:`, error);
            return null; // Return null for failed projects
        }
    });

    const results = await Promise.all(projectPromises);
    return results.filter((p) => p !== null); // Filter out any projects that failed
}

/**
 * Fetches and parses the artifact server directory listing.
 * @returns {Promise<ArtifactInfo[]>} A promise that resolves to an array of artifact information.
 */
async function fetchArtifactStatus(url: string): Promise<ArtifactInfo[]> {
    console.log("Fetching artifact status from Apache server index...");
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch artifact page: ${response.status} ${response.statusText}`);
        }
        const html = await response.text();
        const results: ArtifactInfo[] = [];

        // Regex to find directory rows and extract name and date
        const regex = /<img src="\/icons\/folder.gif".*?<a href="([^"]+)">[^<]+<\/a>.*?<td align="right">([\d\-]{10} [\d:]{5})\s+<\/td>/g;
        let match;

        while ((match = regex.exec(html)) !== null) {
            const name = match[1] || '';
            if (name.includes('i686')) {
                continue;
            }
            const dateString = match[2] || '';
            const lastModifiedDate = new Date(dateString);
            const hoursDiff = (Date.now() - lastModifiedDate.getTime()) / (1000 * 60 * 60);

            results.push({
                name,
                url: `${url}${name}`,
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
        if (cachedGitlabData && cachedArtifactPkgData && cachedArtifactImgData && (now - lastCacheTime < CACHE_DURATION_MS)) {
            console.log("Serving response from cache.");
        } else {
            console.log("Cache expired or empty. Fetching new data...");
            try {
                // Fetch both GitLab and artifact data in parallel
                const [gitlabData, artifactPkgData, artifactImgData] = await Promise.all([
                    fetchGitLabData(),
                    fetchArtifactStatus(ARTIFACT_PKG_URL),
                    fetchArtifactStatus(ARTIFACT_IMG_URL),
                ]);

                cachedGitlabData = gitlabData;
                cachedArtifactPkgData = artifactPkgData;
                cachedArtifactImgData = artifactImgData;
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

        const html = generateHtml(cachedGitlabData || [], cachedArtifactPkgData || [], cachedArtifactImgData || []);
        return new Response(html, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
    },
});


console.log(`🦊 Redox OS Dashboard is running at http://localhost:${PORT}`);

