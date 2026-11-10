import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    // *.types.test.ts files are type-level only: checked by tsc below, never executed.
    exclude: [...configDefaults.exclude, 'test/unit/**/*.types.test.ts'],
    typecheck: {
      enabled: true,
      include: ['test/unit/**/*.types.test.ts'],
      tsconfig: './tsconfig.test.json',
    },
  },
});
