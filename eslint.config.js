// ESLint flat config (ESLint 9 + typescript-eslint 8).
//
// The goal here is to catch real faults — unused code, floating
// promises, accidental `any` drift — without fighting the codebase's
// deliberate choices. Notably: code-map.ts interops with
// web-tree-sitter, whose node objects are untyped, so a bounded
// amount of `any` there is intentional. `no-explicit-any` is
// therefore a *warning* (visible, not blocking) rather than an error.

import js from "@eslint/js"
import tseslint from "typescript-eslint"

export default tseslint.config(
  // Never lint build output, deps, or coverage data.
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "grammars/**"],
  },

  // Base + TypeScript recommended rules.
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Project-wide tuning.
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      // Real faults — keep as errors.
      "@typescript-eslint/no-floating-promises": "off", // needs type info; see typed block below
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-constant-condition": ["error", { checkLoops: false }],

      // Deliberate-choice rules — visible, not blocking.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },

  // Type-aware rules need the TS program; scope them to src + tests.
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json", "./tsconfig.eslint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A dropped promise in a plugin can mean a silent lost write —
      // this one genuinely matters here.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
    },
  },

  // Tests are allowed to be a little looser: fake tree-sitter nodes
  // and mock SDK clients are necessarily loosely typed.
  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
)
