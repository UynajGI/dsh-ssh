/**
 * Client bundle build for dsh-ssh (mirrors the harness `tsdown.client.ts`
 * preset): emits the browser artifact as a CJS closure registered through
 * `window.__ModuleLoader__.load`, resolves platform modules (react, cordis,
 * ui-slots, …) from the loader module table, inlines everything else, and
 * compiles CSS Modules with lightningcss into self-injecting stylesheets.
 */
import { readFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { defineConfig } from 'tsdown'
import { transform } from 'lightningcss'

const ID = 'dsh-ssh'

/** Platform modules the shell shares into the frozen module table. */
const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  // Documented exemption: the runtime tier is registered before dependent bundles.
  '@deepseek-ai/dsh-client-runtime/client',
]

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

export default defineConfig({
  name: `${ID}/client`,
  entry: { client: 'lib/client/index.js' },
  // Browser bundle lands next to the node half; the entryFileNames pin keeps
  // it exactly lib/client.js. clean stays off so the node-half output survives.
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    // Platform modules resolve from the loader module table at runtime.
    neverBundle: (id) => EXTERNALS.includes(id),
    // Everything else must inline: a require() the table cannot answer is a
    // guaranteed runtime throw.
    alwaysBundle: (id) => !EXTERNALS.includes(id),
  },
  plugins: [
    {
      // Bundle purity gate: platform modules stay external, and every other
      // @deepseek-ai value import is a build error (cross-plugin collaboration
      // goes through cordis services; type-only imports are erased).
      name: 'dsh-client-bundle-purity',
      resolveId(source) {
        if (!source.startsWith('@deepseek-ai/')) return null
        if (EXTERNALS.includes(source)) return null
        throw new Error(
          `client bundle purity: "${source}" is not a platform module — `
          + 'cross-plugin value imports are forbidden; collaborate through cordis services',
        )
      },
    },
    {
      // CSS Modules: hashed class map + one auto-injected <style> tag per file.
      name: 'dsh-css-modules-inline',
      resolveId(source, importer) {
        if (!source.endsWith('.module.css')) return null
        const from = importer !== undefined ? resolve(dirname(importer), source) : source
        // The emitted lib/*.js imports its sibling .css; remap the physical
        // stylesheet back onto the source tree.
        const libMarker = `${sep}lib${sep}`
        const at = from.indexOf(libMarker)
        const abs = at >= 0 ? resolve(from.slice(0, at), 'src', from.slice(at + libMarker.length)) : from
        return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
      },
      async load(virtualId) {
        if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
        const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        this.addWatchFile(fileId)
        const source = await readFile(fileId)
        const { code, exports: cssExports } = transform({
          filename: fileId,
          code: source,
          cssModules: { pattern: '[hash]_[local]' },
          minify: true,
        })
        const classMap = {}
        for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
        return [
          `const css = ${JSON.stringify(code.toString())};`,
          `const tagId = ${JSON.stringify(`${ID}/${fileId.split(/[\\/]/).at(-1) ?? ''}`)};`,
          'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
          '  const tag = document.createElement(\'style\');',
          `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
          '  tag.dataset.pluginCss = tagId;',
          '  tag.textContent = css;',
          '  document.head.appendChild(tag);',
          '}',
          `export default ${JSON.stringify(classMap)};`,
        ].join('\n')
      },
    },
  ],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
