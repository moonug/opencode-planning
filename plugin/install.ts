import { existsSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync, readlinkSync, lstatSync, chmodSync, statSync, readFileSync } from "node:fs"
import { dirname, resolve, join, basename } from "node:path"
import { homedir as osHomedir } from "node:os"
import { fileURLToPath } from "node:url"

// On macOS, node:os's homedir() falls back to /etc/passwd when HOME is
// unset or invalid. Prefer process.env.HOME, fall back to homedir() only
// when unset/empty. Test sandbox overrides HOME so this matters.
function homedir(): string {
  const fromEnv = process.env.HOME
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv
  return osHomedir()
}

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

export const SCRIPT_PATH =
  process.env.PLAN_REVIEW_SCRIPT ?? join(PLUGIN_DIR, "bin", "plan-review.py")

export const TUI_PLUGIN_PATH = join(PLUGIN_DIR, "tui-plugin.tsx")

const COMMAND_SOURCES = [
  join(PLUGIN_DIR, "commands", "plan-review.md"),
  join(PLUGIN_DIR, "commands", "set-build-model.md"),
  join(PLUGIN_DIR, "commands", "plan-diag.md"),
]

const { parse: parseJsonc, modify: modifyJsonc, applyEdits } = require("jsonc-parser") as {
  parse: (text: string, errors?: unknown[]) => unknown
  modify: (
    text: string,
    path: Array<string | number>,
    value: unknown,
    options?: { formattingOptions: { insertSpaces: boolean; tabSize: number } }
  ) => any
  applyEdits: (text: string, edits: any) => string
}

export function ensureExecutable(path: string): void {
  try {
    if ((statSync(path).mode & 0o111) === 0) chmodSync(path, 0o755)
  } catch (err) {
    // existsSync catches the missing case later; log unexpected errors.
    console.error(`plan-review: ensureExecutable(${path}) failed: ${(err as Error).message}`)
  }
}

/**
 * Create or refresh a symlink only when the existing path is absent,
// already ours, or a stale symlink into PLUGIN_DIR. Regular files and
// foreign symlinks are never touched.
 */
function ensureManagedLink(source: string, linkPath: string): void {
  let stat: ReturnType<typeof lstatSync> | undefined
  try {
    stat = lstatSync(linkPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`plan-review: lstat failed for ${linkPath}: ${(err as Error).message}`)
    }
  }
  if (stat) {
    if (stat.isSymbolicLink()) {
      try {
        const target = readlinkSync(linkPath)
        const resolved = resolve(dirname(linkPath), target)
        if (resolved === resolve(source)) return // already correct
        if (resolved.startsWith(PLUGIN_DIR)) {
          unlinkSync(linkPath) // stale same-package symlink; update it
        } else {
          // Foreign symlink — don't touch.
          console.error(`plan-review: not overwriting foreign symlink at ${linkPath} -> ${target}`)
          return
        }
      } catch (err) {
        console.error(`plan-review: readlink failed for ${linkPath}: ${(err as Error).message}`)
        return
      }
    } else {
      // Regular file or directory — user-created, don't touch.
      console.error(`plan-review: not overwriting existing file at ${linkPath}`)
      return
    }
  }
  try {
    symlinkSync(source, linkPath)
  } catch (symErr) {
    console.error(
      `plan-review: failed to symlink ${linkPath}: ${(symErr as Error).message}. Symlink is required — run as a user with permission to create symlinks in ~/.config/opencode/commands/`
    )
  }
}

/**
 * Symlink each slash-command into ~/.config/opencode/commands/ without
 * clobbering user files or foreign links. Then register the TUI plugin
 * in tui.jsonc using jsonc-parser so comments and trailing commas are
 * preserved.
 */
export function ensureCommandLinks(): void {
  for (const source of COMMAND_SOURCES) {
    const linkPath = join(homedir(), ".config", "opencode", "commands", basename(source))
    try {
      mkdirSync(dirname(linkPath), { recursive: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        console.error(`plan-review: mkdir failed for ${dirname(linkPath)}: ${(err as Error).message}`)
      }
    }
    ensureManagedLink(source, linkPath)
  }

  // Register TUI plugin in tui.jsonc (NOT in ~/.config/opencode/plugins/ —
  // that path is server-plugin territory and the server loader requires
  // a .server() export, which a TUI plugin doesn't have).
  try {
    const previousTuiPluginPath = join(PLUGIN_DIR, "tui-plugin.ts")
    const tuiJsonPath = join(homedir(), ".config", "opencode", "tui.jsonc")
    const tuiJsonLegacy = join(homedir(), ".config", "opencode", "tui.json")

    // Remove legacy symlink at ~/.config/opencode/plugins/plan-review-tui.ts
    // only if it was created by THIS package (symlink target inside PLUGIN_DIR).
    const legacySymlink = join(homedir(), ".config", "opencode", "plugins", "plan-review-tui.ts")
    try {
      const lstat = lstatSync(legacySymlink)
      if (lstat.isSymbolicLink()) {
        const target = readlinkSync(legacySymlink)
        if (resolve(dirname(legacySymlink), target).startsWith(PLUGIN_DIR)) {
          unlinkSync(legacySymlink)
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`plan-review: legacy symlink check failed: ${(err as Error).message}`)
      }
    }

    let existing: string | undefined
    try {
      existing = readFileSync(tuiJsonPath, "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`plan-review: failed to read ${tuiJsonPath}: ${(err as Error).message}`)
      }
    }
    if (existing === undefined) {
      try {
        existing = readFileSync(tuiJsonLegacy, "utf8")
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error(`plan-review: failed to read ${tuiJsonLegacy}: ${(err as Error).message}`)
        }
      }
    }

    if (existing !== undefined) {
      const errors: unknown[] = []
      const parsed = (parseJsonc(existing, errors) ?? {}) as { plugin?: unknown }
      if (errors.length > 0) {
        console.error(`plan-review: ${tuiJsonPath} has parse errors, not modifying: ${JSON.stringify(errors)}`)
        return
      }
      const plugins = Array.isArray(parsed.plugin) ? (parsed.plugin as unknown[]) : []
      const nextPlugins = plugins.filter((p) => p !== previousTuiPluginPath)
      if (!nextPlugins.includes(TUI_PLUGIN_PATH)) nextPlugins.push(TUI_PLUGIN_PATH)
      if (JSON.stringify(nextPlugins) !== JSON.stringify(plugins)) {
        const edits = modifyJsonc(existing, ["plugin"], nextPlugins, {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        })
        const newText = applyEdits(existing, edits)
        try {
          mkdirSync(dirname(tuiJsonPath), { recursive: true })
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
        }
        writeFileSync(tuiJsonPath, newText)
      }
    } else {
      const newText = JSON.stringify({ plugin: [TUI_PLUGIN_PATH] }, null, 2) + "\n"
      try {
        mkdirSync(dirname(tuiJsonPath), { recursive: true })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      }
      writeFileSync(tuiJsonPath, newText)
    }
  } catch (err) {
    console.error(`plan-review: tui.jsonc registration failed: ${(err as Error).message}`)
  }
}

export function installSelf(): void {
  if (!existsSync(SCRIPT_PATH)) {
    throw new Error(
      `plan-review: helper script not found at ${SCRIPT_PATH}. ` +
        `Set PLAN_REVIEW_SCRIPT env var or restore bin/plan-review.py next to the plugin.`
    )
  }
  ensureExecutable(SCRIPT_PATH)
  ensureCommandLinks()
}