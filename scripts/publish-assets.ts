import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { releaseFiles, releaseMetadata, verifyReleaseArtifacts } from './release-artifacts.js';

if (process.env.GITHUB_REF !== 'refs/heads/main' || process.env.GITHUB_EVENT_NAME !== 'push')
  throw new Error('Only the protected production pipeline can archive release assets.');
const version = z
  .string()
  .regex(/^[a-f0-9]{40}$/)
  .parse(process.env.GITHUB_SHA);
const repository = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  .parse(process.env.GITHUB_REPOSITORY);
let metadata = await releaseMetadata(version);
if (!metadata) {
  await promisify(execFile)(
    'gh',
    [
      'release',
      'create',
      `assets-${version}`,
      ...releaseFiles.map((file) => `dist/${file}`),
      '--repo',
      repository,
      '--target',
      version,
      '--title',
      `Production assets ${version.slice(0, 12)}`,
      '--notes',
      `Browser assets built from protected production commit ${version}.`,
      '--prerelease',
      '--latest=false',
    ],
    { timeout: 120_000 },
  );
  metadata = await releaseMetadata(version);
}
await verifyReleaseArtifacts('dist', version, metadata);
console.log('Archived and verified production browser assets.');
