import { serve, TOML } from 'bun';
import { generateHtml } from './view';

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const CACHE_DURATION_MS = 1 * 60 * 60 * 1000; // 1 hour
const GITLAB_URL = process.env.GITLAB_URL || 'https://gitlab.redox-os.org';
const GITLAB_PRIVATE_TOKEN = process.env.GITLAB_PRIVATE_TOKEN; // Optional, but recommended for higher rate limits
const ARTIFACT_PKG_URL = 'https://static.redox-os.org/pkg/';
const ARTIFACT_IMG_URL = 'https://static.redox-os.org/img/';
export const ARTIFACT_STALE_HOURS = 24;

// Hardcoded list of projects to track
const PROJECTS_TO_TRACK = [
    // critical
    { path: 'redox-os/redox', branch: 'master', pkg: [] },
    { path: 'redox-os/relibc', branch: 'master', pkg: ['relibc'] },
    { path: 'redox-os/base', branch: 'main', pkg: ['base', 'base-initfs'] },
    { path: 'redox-os/bootloader', branch: 'master', pkg: ['bootloader'] },
    { path: 'redox-os/kernel', branch: 'master', pkg: ['kernel'] },
    { path: 'redox-os/redoxfs', branch: 'master', pkg: ['redoxfs'] },
    // non-critical
    { path: 'redox-os/acid', branch: 'master', pkg: ['acid'] },
    { path: 'redox-os/coreutils', branch: 'master', pkg: ['coreutils'] },
    { path: 'redox-os/extrautils', branch: 'master', pkg: ['extrautils'] },
    { path: 'redox-os/installer', branch: 'master', pkg: [] },
    { path: 'redox-os/orbital', branch: 'master', pkg: ['orbital'] },
    { path: 'redox-os/orbutils', branch: 'master', pkg: ['orbutils'] },
    { path: 'redox-os/pkgutils', branch: 'master', pkg: ['pkgutils'] },
    { path: 'redox-os/redoxer', branch: 'master', pkg: [] },
    // website
    { path: 'redox-os/book', branch: 'master', pkg: [] },
    { path: 'redox-os/website', branch: 'master', pkg: [] },
];

const ARTIFACTS_TO_TRACK = [
    "x86_64", "aarch64", "i586", "riscv64gc"
]

// --- IN-MEMORY CACHE ---
let cachedGitlabData: ProjectInfo[] | null = null;
let cachedArtifactData: ArtifactInfo[] | null = null;
export let lastCacheTime = 0;

export interface ProjectInfo {
    id: string;
    name: string;
    path: string;
    url: string;
    status: string;
    pipelineUrl: string;
    commit: {
        id: string,
        message: string;
        author: string;
        date: string;
    } | null;
}

export interface ArtifactInfo {
    name: string;
    pkgUrl: string;
    pkgLastModified: string;
    pkgIsStale: boolean;
    imgUrl: string;
    imgLastModified: string;
    imgIsStale: boolean;
    packages: {
        name: string,
        branch: string,
        toml_path: string,
        project: ProjectInfo,
        toml: PackageToml | null,
    }[],
    repositoryPath: string,
    repository: RepoToml,
}

export interface RepoToml {
    packages: Record<string, string>,
    outdated_packages: Record<string, PackageToml>,
}
export interface PackageToml {
    source_identifier: string,
    commit_identifier: string,
    time_identifier: string,
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
                path,
                url: project.web_url,
                status: latestPipeline?.status || 'no-pipelines',
                pipelineUrl: latestPipeline?.web_url,
                id: project.id,
                commit: latestCommit ? {
                    id: latestCommit.id,
                    message: latestCommit.title,
                    author: latestCommit.author_name,
                    date: latestCommit.created_at, // Keep as ISO string for parsing later
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

async function download(url: string) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
    }
    return await response.text();
}

/**
 * Fetches and parses the artifact server directory listing.
 * @returns {Promise<ArtifactInfo[]>} A promise that resolves to an array of artifact information.
 */
async function fetchArtifactStatus(gitlab: ProjectInfo[]): Promise<ArtifactInfo[]> {
    console.log("Fetching artifact status from build server index...");

    try {
        const htmlPkg = await download(ARTIFACT_PKG_URL);
        const htmlImg = await download(ARTIFACT_IMG_URL);
        const corePkgs = PROJECTS_TO_TRACK.flatMap(x => x.pkg.map(y => ({ name: y, path: x.path, branch: x.branch, project: gitlab.find(g => g.path == x.path) })));
        const archPromises: Promise<null | ArtifactInfo>[] = ARTIFACTS_TO_TRACK.map(async (arch) => {
            const regex = /<img src="\/icons\/folder.gif".*?<a href="([^"]+)">[^<]+<\/a>.*?<td align="right">([\d\-]{10} [\d:]{5})\s+<\/td>/g;
            let match;
            let arti: Partial<ArtifactInfo> = { name: arch };
            while ((match = regex.exec(htmlPkg)) !== null) {
                const name = match[1] || '';
                if (!name.startsWith(arch)) {
                    continue;
                }
                const dateString = match[2] || '';
                const lastModifiedDate = new Date(dateString);
                const hoursDiff = (Date.now() - lastModifiedDate.getTime()) / (1000 * 60 * 60);
                arti.pkgUrl = `${ARTIFACT_PKG_URL}${name}`;
                arti.pkgLastModified = lastModifiedDate.toISOString();
                arti.pkgIsStale = hoursDiff > ARTIFACT_STALE_HOURS;
                break;
            }
            regex.lastIndex = 0;
            while ((match = regex.exec(htmlImg)) !== null) {
                const name = match[1] || '';
                if (!name.startsWith(arch)) {
                    continue;
                }
                const dateString = match[2] || '';
                const lastModifiedDate = new Date(dateString);
                const hoursDiff = (Date.now() - lastModifiedDate.getTime()) / (1000 * 60 * 60);
                arti.imgUrl = `${ARTIFACT_IMG_URL}${name}`;
                arti.imgLastModified = lastModifiedDate.toISOString();
                arti.imgIsStale = hoursDiff > ARTIFACT_STALE_HOURS;
                break;
            }
            if (arti.pkgUrl) {

                arti.repositoryPath = arti.pkgUrl + "repo.toml";
                var tomlr_str = await download(arti.repositoryPath);
                arti.repository = TOML.parse(tomlr_str) as RepoToml;
                arti.repository = {
                    packages: arti.repository.packages || {},
                    outdated_packages: arti.repository.outdated_packages || {},
                }

                let pkgs = corePkgs.map(async (pkg) => {
                    let toml_path = arti.pkgUrl + pkg.name + ".toml";
                    console.log(toml_path);
                    var toml_str = '', toml_parsed = null;
                    try {
                        toml_str = await download(toml_path);
                        toml_parsed = TOML.parse(toml_str) as PackageToml;
                    } catch { }
                    return {
                        name: pkg.name,
                        branch: pkg.branch,
                        project: pkg.project as ProjectInfo,
                        toml_path,
                        toml: toml_parsed,
                    }
                })

                arti.packages = await Promise.all(pkgs);

            }

            return arti as ArtifactInfo;
        })


        const results = await Promise.all(archPromises);
        return results.filter((p) => p !== null); // Filter out any projects that failed
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
        if (cachedGitlabData && cachedArtifactData && (now - lastCacheTime < CACHE_DURATION_MS)) {
            console.log("Serving response from cache.");
        } else {
            console.log("Cache expired or empty. Fetching new data...");
            try {
                // Fetch both GitLab and artifact data in parallel
                const gitlabData = await fetchGitLabData();
                const artifactPkgData = await fetchArtifactStatus(gitlabData);
                cachedGitlabData = gitlabData;
                cachedArtifactData = artifactPkgData;
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

        const html = generateHtml(cachedGitlabData, cachedArtifactData);
        return new Response(html, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
    },
});


console.log(`🦊 Redox OS Dashboard is running at http://localhost:${PORT}`);

