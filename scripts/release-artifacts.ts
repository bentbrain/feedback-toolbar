import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readRegularFile } from '../src/shared/files.js';

export const releaseFiles = ['app.js', 'toolbar.js', 'embed.js', 'embed-module.js', 'styles.css'];
const invoke = promisify(execFile);
const releaseSchema = z.object({
  tag_name: z.string(),
  target_commitish: z.string(),
  assets: z.array(
    z.object({
      name: z.string(),
      size: z.number().max(8 * 1024 * 1024),
      digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    }),
  ),
});
const repository = () =>
  z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    .parse(process.env.GITHUB_REPOSITORY);
const tagFor = (version: string) =>
  `assets-${z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .parse(version)}`;

export async function releaseMetadata(version: string) {
  try {
    const result = await invoke(
      'gh',
      ['api', `repos/${repository()}/releases/tags/${tagFor(version)}`],
      { timeout: 30_000 },
    );
    return releaseSchema.parse(JSON.parse(result.stdout));
  } catch (error) {
    const failure = z.object({ stderr: z.string() }).safeParse(error);
    if (failure.success && failure.data.stderr.includes('HTTP 404')) return null;
    throw new Error('Could not read the repository release artifact metadata.');
  }
}

export async function verifyReleaseArtifacts(
  directory: string,
  version: string,
  metadata: unknown,
) {
  const release = releaseSchema.parse(metadata);
  if (release.tag_name !== tagFor(version) || release.target_commitish !== version)
    throw new Error('Release artifacts do not belong to the active commit.');
  for (const file of releaseFiles) {
    const asset = release.assets.find((asset) => asset.name === file);
    if (!asset) throw new Error(`Release artifact missing: ${file}`);
    const contents = (await readRegularFile(`${directory}/${file}`)).contents;
    const digest = `sha256:${createHash('sha256').update(contents).digest('hex')}`;
    if (contents.length !== asset.size || digest !== asset.digest)
      throw new Error(`Release artifact digest differs: ${file}`);
  }
}

export async function retrieveReleaseArtifacts(version: string, directory: string) {
  const metadata = await releaseMetadata(version);
  if (!metadata) throw new Error('The active commit has no archived release assets.');
  // Only these five assets from this repository's commit release are downloaded by GitHub's CLI.
  for (const file of releaseFiles)
    await invoke(
      'gh',
      [
        'release',
        'download',
        tagFor(version),
        '--repo',
        repository(),
        '--pattern',
        file,
        '--dir',
        directory,
      ],
      { timeout: 60_000 },
    );
  await verifyReleaseArtifacts(directory, version, metadata);
}
