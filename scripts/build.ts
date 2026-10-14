import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { compile, optimize } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';
import { resolve } from 'node:path';

await mkdir('dist', { recursive: true });
const sonnerCss = {
  name: 'external-sonner-styles',
  setup(build: import('esbuild').PluginBuild) {
    build.onLoad({ filter: /sonner\/dist\/index\.mjs$/ }, async ({ path }) => {
      const source = await readFile(path, 'utf8');
      const injections = source.match(/^__insertCSS\(.*\);$/gm);
      if (injections?.length !== 1)
        throw new Error(
          'Sonner CSS packaging changed. Review the CSP-safe external stylesheet integration.',
        );
      return { contents: source.replace(/^__insertCSS\(.*\);$/gm, ''), loader: 'js' };
    });
  },
};
await Promise.all([
  build({
    entryPoints: ['src/browser/app.tsx'],
    bundle: true,
    outfile: 'dist/app.js',
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    sourcemap: true,
    minify: true,
    plugins: [sonnerCss],
    define: { 'process.env.NODE_ENV': '"production"' },
  }),
  build({
    entryPoints: ['src/browser/toolbar.tsx'],
    bundle: true,
    outfile: 'dist/toolbar.js',
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    sourcemap: true,
    minify: true,
    plugins: [sonnerCss],
    define: { 'process.env.NODE_ENV': '"production"' },
  }),
  build({
    entryPoints: ['src/browser/embed.ts'],
    bundle: true,
    outfile: 'dist/embed.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    minify: true,
  }),
  build({
    entryPoints: ['src/browser/embed-module.ts'],
    bundle: true,
    outfile: 'dist/embed-module.js',
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    minify: true,
  }),
  build({
    entryPoints: ['src/server/main.ts', 'src/cli/main.ts', 'src/cli/mcp.ts'],
    bundle: true,
    outdir: 'dist',
    outbase: 'src',
    platform: 'node',
    format: 'esm',
    target: 'node24',
    packages: 'external',
    sourcemap: true,
  }),
]);
const compiler = await compile(await readFile('src/browser/styles.css', 'utf8'), {
  base: resolve('src/browser'),
  onDependency: () => {
    /* This is a one-shot build; the compiler resolves and bundles every stylesheet. */
  },
});
const scanner = new Scanner({ sources: compiler.sources });
const font = await readFile(
  new URL(import.meta.resolve('@fontsource/geist-mono/files/geist-mono-latin-400-normal.woff2')),
);
const fontLicense = await readFile(
  new URL(import.meta.resolve('@fontsource/geist-mono/LICENSE')),
  'utf8',
);
const fontFace = `@font-face{font-family:'Geist Mono';font-style:normal;font-weight:400;font-display:swap;src:url(data:font/woff2;base64,${font.toString('base64')}) format('woff2');}`;
await writeFile(
  'dist/styles.css',
  `/*! ${fontLicense} */\n${optimize(`${fontFace}${compiler.build(scanner.scan())}`, { minify: true }).code}`,
);
await writeFile('dist/server.js', "import './server/main.js';\n");
await writeFile('dist/cli.js', "#!/usr/bin/env node\nimport './cli/main.js';\n", { mode: 0o755 });
await writeFile(
  'dist/embed.d.ts',
  `export interface FeedbackOptions { server: string; projectId: string; theme?: { mode?: 'light' | 'dark' | 'system'; accent?: string; radius?: 'square' | 'soft' | 'round'; density?: 'comfortable' | 'compact'; placement?: 'bottom-right' | 'bottom-left' }; deployment?: string; }\nexport declare function mountFeedback(options: FeedbackOptions): { destroy(): void };\n`,
);
console.log('Built service, CLI, MCP server, and browser embeds.');
