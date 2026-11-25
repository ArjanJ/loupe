# @arjanj/loupe

## 0.1.6

### Patch Changes

- 6b40592: Map repos of any size. Large single-package repos no longer fail with `scanning failed (exit 1)`: files are grouped into at most 60 units before the model plans modules (change the limit with `LOUPE_PLAN_UNITS`), relations prompts are capped, and an unusable model answer falls back to folder-based modules instead of ending the run. The first run after upgrading re-plans, because cached planning answers no longer match.
