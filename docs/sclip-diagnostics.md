# SCLIP diagnostics and reproduction

SCLIP keeps a small, local diagnostic ledger so a failed edit can be reported
without exporting media, prompts, credentials, or absolute file paths.

## What is collected

- editor errors caught by React and global renderer errors (the harmless
  ResizeObserver browser warning is intentionally excluded)
- timeline save and lifecycle-save results
- selection repairs after an item has been removed
- the last 80 SCLIP agent operation audit entries, without tool arguments or prompts
- current project/timeline structure: counts, track metadata, selection, and undo/redo depth

Use the clipboard button in the SCLIP terminal header, or **Copy report** on a
recovered error screen. The result is JSON suitable for attaching to a bug report.

## Reproducible fixture projects

In a development build, open the toolbar bug icon and choose a fixture. Fixtures
contain no real user media and have stable scenario IDs:

| Fixture | Use it to reproduce |
| --- | --- |
| `single-video` | basic selection, properties, undo/redo, save/reopen |
| `multi-track` | layering and track ordering |
| `with-transitions` | transition behavior |
| `with-keyframes` | property changes and animation persistence |
| `complex` | mixed project behavior |
| `stress-test` | a 10-track / 200-item performance and persistence case |

When filing a bug, include the copied report, fixture ID (or a description of
the real project), exact manual steps, expected behavior, and actual behavior.
Do not attach source media unless it is required and you have permission.

## Verification commands

```sh
npx vitest run src/features/project-bundle/services/test-fixtures.test.ts
npx vitest run src/features/editor/components/editor.test.tsx \
  src/features/editor/components/properties-sidebar/index.test.tsx \
  src/features/timeline/hooks/shortcuts/use-editing-shortcuts.test.tsx
```
