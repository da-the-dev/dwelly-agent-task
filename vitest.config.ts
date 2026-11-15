// Only this repo's tests: git worktrees under .claude/worktrees/ hold a second copy of test/.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
