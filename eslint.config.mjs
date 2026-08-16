import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

/**
 * The determinism ban list.
 *
 * BALLAST's central claim is that a run is a pure function of its seed. That
 * claim is only worth anything if it is mechanically enforced, so everything
 * that could smuggle in ambient nondeterminism is a build error inside
 * `src/core/**`, `src/policy/**` and `src/oracle/**` — the three trees whose
 * output must be reproducible.
 *
 * The CLI and the tests are deliberately exempt: the CLI does real file I/O and
 * the determinism guard itself needs to spawn processes.
 *
 * Each entry names WHY, because a rule whose reason is unstated gets disabled
 * by the next person who hits it.
 */
const DETERMINISM_BANS = [
  {
    selector: "MemberExpression[object.name='Math'][property.name='random']",
    message:
      "Math.random() is ambient nondeterminism. Thread the seeded Rng from core/rng.ts instead.",
  },
  {
    selector: "MemberExpression[object.name='Date'][property.name='now']",
    message:
      "Date.now() is wall-clock. Simulated time comes from the Clock (core/clock.ts); nothing here may observe real time.",
  },
  {
    selector: "NewExpression[callee.name='Date']",
    message:
      "new Date() is wall-clock. Use virtual ticks from the Clock; a decision that depends on the real date is not replayable.",
  },
  {
    selector: "MemberExpression[object.name='process'][property.name='hrtime']",
    message: "process.hrtime is wall-clock. Virtual time only — see docs/DETERMINISM.md.",
  },
  {
    selector:
      "CallExpression[callee.name=/^(setTimeout|setInterval|setImmediate|queueMicrotask)$/]",
    message:
      "Real timers introduce scheduling nondeterminism. Schedule an event on the Clock's queue instead.",
  },
  {
    selector: "AwaitExpression",
    message:
      "await introduces interleaving the seed does not control. The simulation core is synchronous by design.",
  },
  {
    selector:
      ":matches(FunctionDeclaration, FunctionExpression, ArrowFunctionExpression)[async=true]",
    message:
      "async functions introduce interleaving the seed does not control. The simulation core is synchronous by design.",
  },
  {
    selector: "NewExpression[callee.name='Promise']",
    message:
      "Promises introduce interleaving the seed does not control. The simulation core is synchronous by design.",
  },
  {
    selector: "ForInStatement",
    message:
      "for..in order is engine-defined for some key shapes. Use sortedKeys() from core/order.ts.",
  },
  {
    selector:
      "CallExpression[callee.object.name='Object'][callee.property.name=/^(keys|values|entries)$/]",
    message:
      "Object.keys/values/entries yields insertion order, which silently couples output to construction order. Use sortedKeys/sortedEntries from core/order.ts.",
  },
  {
    selector:
      "CallExpression[callee.property.name='forEach'][callee.object.type='Identifier']",
    message:
      "Iterate explicitly over a sorted sequence so the order is visible at the call site (core/order.ts).",
  },
];

export default [
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2023, sourceType: "module" },
      globals: {
        process: "readonly",
        console: "readonly",
        URL: "readonly",
      },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "no-console": "off",
      eqeqeq: ["error", "always"],
      "no-var": "error",
      "prefer-const": "error",
    },
  },
  {
    // The determinism perimeter.
    files: [
      "src/core/**/*.ts",
      "src/policy/**/*.ts",
      "src/oracle/**/*.ts",
      "src/sim/**/*.ts",
    ],
    rules: {
      "no-restricted-syntax": ["error", ...DETERMINISM_BANS],
    },
  },
  {
    // core/order.ts is the ONE place allowed to call Object.keys — it is the
    // sanctioned wrapper the ban points everyone at.
    files: ["src/core/order.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
  {
    files: ["test/**/*.ts", "src/cli/**/*.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
];
