import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    // Mirror the "@/*" alias from tsconfig so tests import the same way the app does.
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // The suite is pure data and logic — no DOM, so the default node
    // environment keeps it fast enough to run on every save.
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.ts'],
      exclude: ['src/lib/**/__tests__/**', 'src/lib/types.ts'],
      reporter: ['text', 'lcov'],
    },
  },
})
