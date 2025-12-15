import { ARTIFACT_STALE_HOURS, lastCacheTime } from './app';
import type { ProjectInfo, ArtifactInfo } from './app';


/**
 * Generates the full HTML page to display the project statuses.
 * @param {ProjectInfo[]} gitlabData - The array of project data to render.
 * @param {ArtifactInfo[]} artifactPkgData - The array of artifact data to render.
 * @returns {string} A complete HTML document as a string.
 */
export function generateHtml(gitlabData: ProjectInfo[], artifactPkgData: ArtifactInfo[], artifactImgData: ArtifactInfo[]): string {
    const gitlabTableRows = gitlabData.map(repo => `
        <tr>
            <td><a href="${repo.url}" data-id="${repo.id}" target="_blank" rel="noopener noreferrer">${repo.name}</a></td>
            <td>${getStatusBadge(repo.status, repo.pipelineUrl)}</td>
            <td class="commit-msg">${repo.commit?.message || 'N/A'}</td>
            <td>${repo.commit?.author || 'N/A'}</td>
            <td>${repo.commit?.date ? humanize(Date.now() - new Date(repo.commit.date).getTime()) : 'N/A'}</td>
        </tr>
    `).join('');

    const artifactPkgTableRows = artifactPkgData.map(artifact => `
         <tr>
            <td><a href="${artifact.url}" target="_blank" rel="noopener noreferrer">${artifact.name}</a></td>
            <td>${getArtifactStatusBadge(artifact.isStale)}</td>
            <td>${humanize(Date.now() - new Date(artifact.lastModified).getTime())}</td>
        </tr>
    `).join('');

    const artifactImgTableRows = artifactImgData.map(artifact => `
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
            overflow: auto;
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
        <h2>Packages Status</h2>
        <table>
            <thead>
                <tr>
                    <th>Target</th>
                    <th>Status</th>
                    <th>Last Updated</th>
                </tr>
            </thead>
            <tbody>
                ${artifactPkgTableRows}
            </tbody>
        </table>
    </div>

    <div class="container">
        <h2>Image Status</h2>
        <table>
            <thead>
                <tr>
                    <th>Target</th>
                    <th>Status</th>
                    <th>Last Updated</th>
                </tr>
            </thead>
            <tbody>
                ${artifactImgTableRows}
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
export function getStatusBadge(status: string, pipelineUrl: string): string {
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
export function getArtifactStatusBadge(isStale: boolean): string {
    const color = isStale ? '#dc3545' : '#28a745';
    const text = isStale ? `Stale (> ${ARTIFACT_STALE_HOURS}h)` : 'OK';
    return `<span class="status" style="background-color: ${color};">${text}</span>`;
}
