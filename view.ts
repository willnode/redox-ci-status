import { ARTIFACT_STALE_HOURS, lastCacheTime } from './app';
import type { ProjectInfo, ArtifactInfo } from './app';
import css from './style.css'  with { type: "text" };

/**
 * Generates the full HTML page to display the project statuses.
 * @param {ProjectInfo[]} gitlabData - The array of project data to render.
 * @param {ArtifactInfo[]} artifactData - The array of pkg artifact data to render.
 * @returns {string} A complete HTML document as a string.
 */
export function generateHtml(gitlabData: ProjectInfo[], artifactData: ArtifactInfo[]): string {
    const gitlabTableRows = gitlabData.map(repo => `
        <tr>
            <td><a href="${repo.url}" data-id="${repo.id}" target="_blank" rel="noopener noreferrer">${repo.name}</a></td>
            <td>${getStatusBadge(repo.status, repo.pipelineUrl)}</td>
            <td class="commit-msg">${repo.commit?.message || 'N/A'}</td>
            <td>${repo.commit?.author || 'N/A'}</td>
            <td>${repo.commit?.date ? humanize(Date.now() - new Date(repo.commit.date).getTime()) : 'N/A'}</td>
        </tr>
    `).join('');


    const artifactTableRows = artifactData.map(artifact => {
        let packagesList = artifact.packages.map(x => {
            let pkg_commit = x.toml?.source_identifier.substring(0, 7) || '-';
            let rpo_commit = x.project.commit?.id.substring(0, 7) || '-';
            return `<div class="item ${pkg_commit == rpo_commit ? 'latest' : (x.toml?.time_identifier &&
                ((Date.now() - new Date(x.toml.time_identifier).getTime()) < 1000 * 60 * 60 * ARTIFACT_STALE_HOURS) ? 'pending' : 'outdated')}">
                <h4>${x.name}</h4>
                 <div> 
                ${pkg_commit == rpo_commit ?
                    `<a href="${x.toml_path}" target="_blank">${pkg_commit}</a> (<a href="${x.project.url}/-/commits/${x.branch}" target="_blank">latest</a>)` :
                    `<a href="${x.toml_path}" target="_blank">${pkg_commit}</a> vs <a href="${x.project.url}/-/commits/${x.branch}" target="_blank">${rpo_commit}</a>`}
                 </div>
                 <div>
                    published ${x.toml?.time_identifier ? humanize(Date.now() - new Date(x.toml.time_identifier).getTime()) : 'N/A'}
                 </div>
            </div>`
        })
        let outdatedList = Object.entries(artifact.repository.outdated_packages).map(([name, src]) => {
            return `<div class="item outdated">
                <h4>${name}</h4>
                <div>
                    since ${src.time_identifier ? humanize(Date.now() - new Date(src.time_identifier).getTime()) : 'N/A'}
                 </div>
            </div>`
        })
        let outdated_packages_len = Object.keys(artifact.repository.outdated_packages).length;
        let all_packages_len = Object.keys({ ...artifact.repository.packages, ...artifact.repository.outdated_packages }).length;
        return `
        <div class="artifact">
            <div class="head">
                <h3>${artifact.name}</h3>
                <div>
                    <h4>Package ${getArtifactStatusBadge(artifact.pkgIsStale)}</h4>
                    <p><a href="${artifact.pkgUrl}" target="_blank" rel="noopener noreferrer">
                        ${humanize(Date.now() - new Date(artifact.pkgLastModified).getTime())}
                    </a></p>
                </div>
                <div>
                    <h4>Repository (${all_packages_len - outdated_packages_len} / ${all_packages_len})</h4>
                    <p><a href="${artifact.repositoryPath}" target="_blank" rel="noopener noreferrer">
                        ${outdated_packages_len} outdated packages
                    </a></p>
                </div>
                <div>
                    <h4>Image ${getArtifactStatusBadge(artifact.imgIsStale)}</h4>
                    <p><a href="${artifact.imgUrl}" target="_blank" rel="noopener noreferrer">
                        ${humanize(Date.now() - new Date(artifact.imgLastModified).getTime())}
                    </a></p>
                </div>
            </div>
            <div class="core-packages">
                ${packagesList.join('')}
            </div>
            ${outdatedList.length > 0 ? `
            <h4 style="text-align: center">Outdated Packages</h4>
                <div class="outdated-packages">
                ${outdatedList.join('')}
            </div>` : ''}
        </div>
    `}).join('');

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Redox OS CI Dashboard</title>
    <style>${css}</style>
</head>
<body>
    <div class="container">
        <h1>Redox OS CI Dashboard</h1>

        <h2>Packages Status</h2>
        ${artifactTableRows}

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
