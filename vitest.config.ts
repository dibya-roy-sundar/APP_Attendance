import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Exists so unit tests can import modules that use the `@/` alias the app uses.
 * Without it, importing anything under src/lib that reaches for `@/lib/...`
 * fails to resolve.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
})
