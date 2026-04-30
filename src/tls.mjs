/**
 * TLS configuration for upstream HTTPS requests.
 *
 * Supports:
 *   - trustSystemCerts: auto-load OS certificate store (macOS Keychain / Linux /etc/ssl/certs)
 *   - ca: path(s) to custom PEM CA certificate files (restricted to well-known cert dirs)
 *   - rejectUnauthorized: toggle cert verification (default: true)
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Agent as HttpsAgent } from 'node:https';
import { rootCertificates } from 'node:tls';
import { platform } from 'node:os';

const PLATFORM = platform();

const ALLOWED_CA_DIRS = [
  '/etc/ssl/certs',
  '/etc/pki/tls/certs',
  '/usr/local/share/ca-certificates',
  '/usr/share/ca-certificates',
];

/**
 * Load macOS system certificates from Keychain.
 * Uses execFileSync to avoid shell injection.
 */
function loadMacSystemCerts() {
  const keychains = [
    '/System/Library/Keychains/SystemRootCertificates.keychain',
    '/Library/Keychains/System.keychain',
  ];

  const pemChunks = [];
  for (const kc of keychains) {
    try {
      const result = execFileSync(
        'security', ['find-certificate', '-a', '-p', kc],
        { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      if (result) pemChunks.push(result);
    } catch { /* keychain not accessible, skip */ }
  }
  return pemChunks.join('\n');
}

/**
 * Load Linux system certificates from /etc/ssl/certs/ or similar.
 */
function loadLinuxSystemCerts() {
  const pemChunks = [];
  for (const dir of ALLOWED_CA_DIRS) {
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir);
      for (const file of files) {
        if (!file.endsWith('.pem') && !file.endsWith('.crt')) continue;
        try {
          const content = readFileSync(join(dir, file), 'utf8');
          if (content.includes('BEGIN CERTIFICATE')) {
            pemChunks.push(content);
          }
        } catch { /* skip unreadable files */ }
      }
    } catch { /* skip unreadable dirs */ }
  }
  return pemChunks.join('\n');
}

/**
 * Load system certificates for the current platform.
 */
function loadSystemCerts() {
  if (PLATFORM === 'darwin') return loadMacSystemCerts();
  if (PLATFORM === 'linux') return loadLinuxSystemCerts();
  return '';
}

/**
 * Validate that a custom CA path is within allowed directories.
 * Prevents arbitrary file reads via path traversal.
 */
function isAllowedCaPath(p) {
  const resolved = resolve(p);
  return ALLOWED_CA_DIRS.some(d => resolved.startsWith(d + '/'));
}

/**
 * Load CA certificates from file path(s).
 * @param {string|string[]} paths - Single path or array of paths to PEM files
 * @returns {string} Combined PEM content
 */
function loadCustomCerts(paths) {
  const pathList = Array.isArray(paths) ? paths : [paths];
  const pemChunks = [];
  for (const p of pathList) {
    if (!isAllowedCaPath(p)) {
      console.warn(`TLS: CA path outside allowed directories, skipping: ${p} (allowed: ${ALLOWED_CA_DIRS.join(', ')})`);
      continue;
    }
    if (!existsSync(p)) {
      console.warn(`TLS: CA file not found, skipping: ${p}`);
      continue;
    }
    try {
      const content = readFileSync(p, 'utf8');
      if (content.includes('BEGIN CERTIFICATE')) {
        pemChunks.push(content);
      } else {
        console.warn(`TLS: No PEM certificate found in: ${p}`);
      }
    } catch (e) {
      console.warn(`TLS: Failed to read CA file ${p}: ${e.message}`);
    }
  }
  return pemChunks.join('\n');
}

/**
 * Parse PEM content into an array of individual certificate strings.
 */
function splitPem(pem) {
  const certs = [];
  const regex = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
  let match;
  while ((match = regex.exec(pem)) !== null) {
    certs.push(match[0]);
  }
  return certs;
}

/**
 * Build an HTTPS agent with custom TLS settings.
 *
 * @param {object} tlsConfig - TLS configuration from router config
 * @param {boolean} [tlsConfig.trustSystemCerts] - Load OS certificate store
 * @param {string|string[]} [tlsConfig.ca] - Path(s) to custom CA PEM files
 * @param {boolean} [tlsConfig.rejectUnauthorized=true] - Reject invalid certs
 * @returns {{ agent: HttpsAgent | null, warn?: string }}
 *   agent is null when no custom TLS config is needed (use Node defaults)
 */
export function buildTlsAgent(tlsConfig) {
  if (!tlsConfig || typeof tlsConfig !== 'object') {
    return { agent: null };
  }

  const rejectUnauthorized = tlsConfig.rejectUnauthorized !== false;
  const trustSystem = tlsConfig.trustSystemCerts === true;
  const customPaths = tlsConfig.ca;

  if (!trustSystem && !customPaths && rejectUnauthorized) {
    return { agent: null };
  }

  let warn;
  if (!rejectUnauthorized) {
    warn = 'TLS certificate verification is DISABLED (rejectUnauthorized=false). This is insecure.';
    console.warn(`WARNING: ${warn}`);
  }

  const caCerts = [];

  if (rootCertificates) {
    caCerts.push(...rootCertificates);
  }

  if (trustSystem) {
    const systemPem = loadSystemCerts();
    const systemCerts = splitPem(systemPem);
    if (systemCerts.length > 0) {
      caCerts.push(...systemCerts);
    } else {
      console.warn('TLS: trustSystemCerts enabled but no system certificates found');
    }
  }

  if (customPaths) {
    const customPem = loadCustomCerts(customPaths);
    const customCerts = splitPem(customPem);
    if (customCerts.length > 0) {
      caCerts.push(...customCerts);
    }
  }

  const agent = new HttpsAgent({
    rejectUnauthorized,
    ca: caCerts.length > 0 ? caCerts : undefined,
  });

  return { agent, warn };
}
