/**
 * Directory-resolved TUI entrypoint.
 *
 * The opencode2 TUI loads plugin DIRECTORY targets as `<dir>/tui`
 * (packages/tui/src/plugin/context.tsx:348), so this file must exist for
 * `/Users/moonug/projects/opencode-planning-v2/plugin` to contribute a
 * sidebar. The implementation lives in tui-v2.tsx.
 */
export { default } from "./tui-v2"
