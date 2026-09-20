/**
 * Types for the mutation-scope helper.
 *
 * The helper is plain `.mjs` because it is a build script, but
 * `test/mutation.test.ts` asserts its behaviour and a test full of `as`
 * casts hides the very mistakes it exists to catch.
 */
export declare const root: string;
export declare const MUTATED_SCOPES: readonly string[];
export declare const TARGET_DIRS: readonly string[];
export declare const UNMUTATED_SCOPES: readonly string[];
export declare function reachesMutatedCode(entry: string): boolean;
export declare function reachesFile(entry: string, target: string): boolean;
export declare function allTestFiles(): string[];
export declare function gradedSuite(): { graded: string[]; skipped: string[] };
