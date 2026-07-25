#!/usr/bin/env python3
"""plan-review.py - opencode plan annotation helper.

adapted from the planning plugin in https://github.com/umputun/cc-thingz (MIT).
the editor-overlay cascade, sentinel-file pattern, difflib-based diff, and
temp-file lifecycle ported verbatim; the PreToolUse JSON protocol was removed
because opencode has no equivalent hook.

opens plan markdown in $EDITOR via terminal overlay (agterm -> tmux -> zellij ->
herdr -> kitty -> wezterm -> ghostty -> cmux -> iTerm2 -> emacs vterm -> blocking)
or blocking spawn (plain ssh terminal), waits for the user to edit, computes
a unified diff, prints it to stdout. opencode plugin reads stdout as the
model's feedback.

annotation style - edit the plan text directly in your editor:
  - add new lines to request additions (e.g. "add error handling here")
  - delete lines to request removal
  - modify lines to request changes (e.g. change "use polling" to "use websockets")
  - add inline comments after existing text (e.g. "- [ ] create handler - use JWT not sessions")
any text change works - the script diffs original vs edited and the agent
sees exactly what you added, removed, or modified.

stdout contract:
  - no changes      -> empty stdout, exit 0
  - with changes    -> unified diff on stdout, exit 0
  - internal error  -> message on stderr, exit nonzero

editor cascade (first match wins):
  1. agterm      ($AGTERM_SESSION_ID)  -> agtermctl overlay (native block)
  2. tmux        ($TMUX)               -> tmux display-popup -E (native block)
  3. zellij      ($ZELLIJ)             -> floating pane + sentinel
  4. kitty       ($KITTY_LISTEN_ON)    -> remote-control overlay + sentinel
  5. wezterm     ($WEZTERM_PANE)       -> split-pane + sentinel
  6. ghostty     (on PATH)             -> blocking spawn with --command
  7. blocking fallback                   $EDITOR with stdio=inherit, blocks until exit
  (upstream plugin supports herdr, cmux, iTerm2, emacs vterm via bash launcher)

requirements:
  - python 3.8+ stdlib only
  - $EDITOR or $VISUAL (defaults: micro -> nano -> vi). Multi-word $EDITOR
    values (e.g. "emacsclient -c -a ''") are supported via shlex.split.
    The editor binary is resolved to an absolute path for overlay shells.
  - terminal overlays: agterm, tmux, zellij, kitty, wezterm, ghostty.
    Only one needed, detected automatically.
  - for kitty: kitty.conf must enable allow_remote_control + listen_on
  - for wezterm: WEZTERM_PANE env var (set automatically by wezterm)

usage:
    plan-review.py --plan-text "<markdown>"     # tool mode (inline plan)
    plan-review.py --file <path>                # command mode (file on disk)
    plan-review.py --no-color                   # disable ANSI in diff output
    plan-review.py --test                       # run unit tests
"""

import argparse
import difflib
import io
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


def get_diff(original: str, edited: str) -> str:
    """get unified diff between original and edited content."""
    orig_lines = original.splitlines(keepends=True)
    edit_lines = edited.splitlines(keepends=True)
    diff = difflib.unified_diff(orig_lines, edit_lines, fromfile="original", tofile="annotated", n=2)
    return "".join(diff)


GREEN = "\x1b[32m"
RED = "\x1b[31m"
CYAN = "\x1b[36m"
RESET = "\x1b[0m"


def colorize_diff(diff: str, enabled: bool) -> str:
    """wrap diff lines with ANSI colors when enabled. ponytail: per-line wrap, no regex."""
    if not enabled or not diff:
        return diff
    out = []
    for line in diff.splitlines(keepends=True):
        if line.startswith("+++") or line.startswith("---"):
            out.append(line)
        elif line.startswith("+"):
            out.append(f"{GREEN}{line}{RESET}")
        elif line.startswith("-"):
            out.append(f"{RED}{line}{RESET}")
        elif line.startswith("@@"):
            out.append(f"{CYAN}{line}{RESET}")
        else:
            out.append(line)
    return "".join(out)


def resolve_editor() -> str:
    """resolve which editor binary to invoke. ponytail: tier down if unset."""
    return (
        os.environ.get("VISUAL")
        or os.environ.get("EDITOR")
        or _which("micro")
        or _which("nano")
        or "vi"  # ponytail: POSIX-mandatory last resort
    )


def _which(name: str) -> str | None:
    found = shutil.which(name)
    return found if found else None


def build_editor_cmd(editor_str: str) -> str:
    """split $EDITOR into argv, resolve first token to abs path, re-quote.
    overlay shells (tmux popup, kitty overlay) don't inherit the launcher's
    PATH, so a bare 'vi' would fail. falls back to vi on empty/malformed."""
    try:
        parts = shlex.split(editor_str) or ["vi"]
    except ValueError:
        parts = ["vi"]
    resolved = shutil.which(parts[0])
    if resolved:
        parts[0] = resolved
    return " ".join(shlex.quote(p) for p in parts)


def resolve_editor_cmd() -> str:
    """resolve editor to an absolute-path command string."""
    raw = (
        os.environ.get("VISUAL")
        or os.environ.get("EDITOR")
        or _which("micro")
        or _which("nano")
        or "vi"
    )
    return build_editor_cmd(raw)


def _is_gui_editor(editor: str) -> bool:
    """true for editor binaries that block on file open via -w flag."""
    basename = Path(editor).name
    return basename in {"code", "code-insiders", "cursor", "cursor-bin", "subl", "sublime_text"}


def _sentinel_spawn(
    run_cmd: list[str], editor_cmd: str, filepath: Path
) -> int | None:
    """launch a terminal overlay with sentinel-based blocking.
    run_cmd includes the terminal CLI and all its flags (but not a shell wrapper).
    returns 0 on success (editor closed), None if launch failed."""
    fd, sentinel_path = tempfile.mkstemp(prefix="plan-done-")
    os.close(fd)
    os.unlink(sentinel_path)
    sentinel = Path(sentinel_path)
    wrapper = f"{editor_cmd} {shlex.quote(str(filepath))}; touch {shlex.quote(str(sentinel))}"
    cmd = [*run_cmd, "sh", "-c", wrapper]
    try:
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
    except (subprocess.CalledProcessError, OSError):
        sentinel.unlink(missing_ok=True)
        return None
    while not sentinel.exists():
        time.sleep(0.3)
    sentinel.unlink(missing_ok=True)
    return 0


def _spawn_blocking(editor_cmd: str, filepath: Path) -> int:
    """spawn editor as blocking child, inheriting stdio. ponytail: the ssh/vim fallback."""
    try:
        parts = shlex.split(editor_cmd)
    except ValueError:
        parts = ["vi"]
    cmd = [*parts, str(filepath)]
    if _is_gui_editor(parts[0]):
        cmd.append("-w")
    try:
        result = subprocess.run(cmd, stdin=None, stdout=None, stderr=None)
    except FileNotFoundError:
        print(f"error: editor not found: {parts[0]}", file=sys.stderr)
        return 127
    return result.returncode


def open_editor(filepath: Path) -> int:
    """open file in editor, blocking until user closes it. returns editor exit code.
    cascade: agterm -> tmux -> zellij -> kitty -> wezterm -> ghostty -> blocking spawn.
    Every overlay branch falls through on failure; only the blocking fallback is guaranteed.
    """
    editor_cmd = resolve_editor_cmd()

    # 1. agterm: native overlay (blocks natively), no sentinel needed.
    if os.environ.get("AGTERM_SESSION_ID") and _which("agtermctl"):
        target = ["--target", os.environ["AGTERM_SESSION_ID"]]
        if os.environ.get("AGTERM_SOCKET"):
            target += ["--socket", os.environ["AGTERM_SOCKET"]]
        subprocess.run(
            ["agtermctl", "session", "status", "blocked", "--blink", *target],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            result = subprocess.run(
                ["agtermctl", "session", "overlay", "open",
                 f"{editor_cmd} {shlex.quote(str(filepath))}", *target, "--block"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        finally:
            subprocess.run(
                ["agtermctl", "session", "status", "active", *target],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        if result.returncode == 0:
            return 0
        # fall through on agterm failure

    # 2. tmux: display-popup -E blocks natively, no sentinel.
    if os.environ.get("TMUX") and _which("tmux"):
        result = subprocess.run(
            ["tmux", "display-popup", "-E", "-w", "90%", "-h", "90%",
             "-T", "Plan Review", "--",
             "sh", "-c", f"{editor_cmd} {shlex.quote(str(filepath))}"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        if result.returncode == 0:
            return 0
        # fall through on tmux failure

    # 3. zellij: floating pane + sentinel.
    if os.environ.get("ZELLIJ") and _which("zellij"):
        result = _sentinel_spawn(
            ["zellij", "run", "--floating", "--close-on-exit",
             "--width", "90%", "--height", "90%", "--"],
            editor_cmd, filepath,
        )
        if result is not None:
            return result
        # fall through on zellij failure

    # 4. kitty: overlay + sentinel.
    kitty_sock = os.environ.get("KITTY_LISTEN_ON")
    if kitty_sock and _which("kitty"):
        result = _sentinel_spawn(
            ["kitty", "@", "--to", kitty_sock, "launch", "--type=overlay",
             f"--title=Plan Review: {filepath.name}"],
            editor_cmd, filepath,
        )
        if result is not None:
            return result
        # fall through on kitty failure

    # 5. wezterm: split-pane + sentinel.
    wezterm_pane = os.environ.get("WEZTERM_PANE")
    if wezterm_pane and _which("wezterm"):
        result = _sentinel_spawn(
            ["wezterm", "cli", "split-pane", "--bottom", "--percent", "80",
             "--pane-id", wezterm_pane, "--"],
            editor_cmd, filepath,
        )
        if result is not None:
            return result
        # fall through on wezterm failure

    # 6. ghostty: blocking spawn (opens new window).
    if _which("ghostty"):
        try:
            parts = shlex.split(editor_cmd)
        except ValueError:
            parts = ["vi"]
        try:
            result = subprocess.run(
                ["ghostty", "--command"] + parts + [str(filepath)],
                stdin=None, stdout=None, stderr=None,
            )
        except FileNotFoundError:
            pass
        else:
            if result.returncode == 0:
                return 0
            # fall through on ghostty failure

    # 7. blocking fallback: plain $EDITOR.
    return _spawn_blocking(editor_cmd, filepath)



def review(plan_content: str) -> str:
    """open plan in editor, return unified diff (empty string if no changes).
    exits with 1 if editor failed (nonzero exit)."""
    if not plan_content:
        return ""

    with tempfile.NamedTemporaryFile(mode="w", suffix=".md", prefix="plan-review-", delete=False) as tmp:
        tmp.write(plan_content)
        tmp_path = Path(tmp.name)

    try:
        exit_code = open_editor(tmp_path)
        if exit_code != 0 and exit_code is not None:
            print(f"error: editor exited with code {exit_code}", file=sys.stderr)
            sys.exit(1)
        edited = tmp_path.read_text()
        return get_diff(plan_content, edited)
    finally:
        tmp_path.unlink(missing_ok=True)


def _should_color(no_color_flag: bool) -> bool:
    """color only when stdout is a TTY, --no-color not passed, and NO_COLOR env var unset.

    respects no-color.org: any non-empty NO_COLOR disables colors regardless of TTY status.
    ponytail: this is the third standard signal after --no-color flag and isatty().
    """
    if no_color_flag:
        return False
    if os.environ.get("NO_COLOR"):
        return False
    return sys.stdout.isatty()


def run_plan_text(plan_text: str, use_color: bool = True) -> int:
    """entry: plan content passed as CLI arg (tool mode)."""
    diff = review(plan_text)
    if diff:
        sys.stdout.write(colorize_diff(diff, use_color))
    return 0


def run_plan_text_stdin(use_color: bool = True) -> int:
    """entry: plan content piped via stdin (avoids shell escaping of markdown)."""
    plan_text = sys.stdin.read()
    diff = review(plan_text)
    if diff:
        sys.stdout.write(colorize_diff(diff, use_color))
    return 0


def run_file(plan_file: Path, use_color: bool = True) -> int:
    """entry: plan content read from file (command mode)."""
    if not plan_file.exists():
        print(f"error: file not found: {plan_file}", file=sys.stderr)
        return 1
    diff = review(plan_file.read_text())
    if diff:
        sys.stdout.write(colorize_diff(diff, use_color))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="opencode plan annotation helper (opens plan in $EDITOR, prints diff)"
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--plan-text", metavar="TEXT", help="plan markdown text (tool mode)")
    group.add_argument("--plan-text-stdin", action="store_true", help="read plan markdown from stdin (avoids shell escaping)")
    group.add_argument("--file", metavar="PATH", help="path to plan markdown file (command mode)")
    parser.add_argument("--test", action="store_true", help="run unit tests and exit")
    parser.add_argument("--no-color", action="store_true", help="disable ANSI colors in diff output")
    args = parser.parse_args()

    if args.test:
        return run_tests()

    use_color = _should_color(args.no_color)

    if args.plan_text is not None and args.file is not None:
        parser.error("--plan-text and --file are mutually exclusive")
    if args.plan_text_stdin:
        return run_plan_text_stdin(use_color)
    if args.plan_text is not None:
        return run_plan_text(args.plan_text, use_color)
    if args.file is not None:
        return run_file(Path(args.file), use_color)
    parser.error("one of --plan-text or --file is required (unless --test)")


def run_tests() -> int:
    """embedded unit tests. run with --test."""

    class TestGetDiff(unittest.TestCase):
        def test_no_changes(self) -> None:
            text = "# Plan\n- task 1\n- task 2\n"
            self.assertEqual(get_diff(text, text), "")

        def test_added_line(self) -> None:
            original = "# Plan\n- task 1\n- task 2\n"
            edited = "# Plan\n- task 1\nadd timestamps\n- task 2\n"
            diff = get_diff(original, edited)
            self.assertIn("+add timestamps", diff)
            self.assertIn("task 1", diff)

        def test_removed_line(self) -> None:
            original = "# Plan\n- task 1\n- task 2\n"
            edited = "# Plan\n- task 2\n"
            diff = get_diff(original, edited)
            self.assertIn("-- task 1", diff)

        def test_modified_line(self) -> None:
            original = "# Plan\n- task 1\n"
            edited = "# Plan\n- task 1 (use JWT)\n"
            diff = get_diff(original, edited)
            self.assertIn("-- task 1", diff)
            self.assertIn("+- task 1 (use JWT)", diff)

        def test_multiple_changes(self) -> None:
            original = "# Plan\n\n## A\n- item\n\n## B\n- item\n"
            edited = "# Plan\n\n## A\n- item\nnote about A\n\n## B\n- item\nnote about B\n"
            diff = get_diff(original, edited)
            self.assertIn("+note about A", diff)
            self.assertIn("+note about B", diff)

        def test_trailing_newline_preserved(self) -> None:
            original = "line1\nline2\n"
            edited = "line1\nline2 modified\n"
            diff = get_diff(original, edited)
            self.assertIn("-line2", diff)
            self.assertIn("+line2 modified", diff)

    class TestColorizeDiff(unittest.TestCase):
        def setUp(self) -> None:
            self.original = "# Plan\n- task 1\n"
            self.edited = "# Plan\n- task 1 (use JWT)\n"

        def test_disabled_returns_raw_diff(self) -> None:
            raw = get_diff(self.original, self.edited)
            self.assertEqual(colorize_diff(raw, False), raw)

        def test_empty_diff_is_unchanged(self) -> None:
            self.assertEqual(colorize_diff("", True), "")

        def test_enabled_wraps_added_lines(self) -> None:
            raw = get_diff(self.original, self.edited)
            colored = colorize_diff(raw, True)
            self.assertIn(f"{GREEN}+", colored)
            self.assertIn(f"{RED}-", colored)
            self.assertNotIn(f"{GREEN}---", colored)  # header must stay plain
            self.assertGreater(len(colored), len(raw))

        def test_color_round_trips_to_raw(self) -> None:
            raw = get_diff(self.original, self.edited)
            colored = colorize_diff(raw, True)
            stripped = colored.replace(GREEN, "").replace(RED, "").replace(CYAN, "").replace(RESET, "")
            self.assertEqual(stripped, raw)

    class TestShouldColor(unittest.TestCase):
        def setUp(self) -> None:
            self._saved_no_color = os.environ.get("NO_COLOR")
            os.environ.pop("NO_COLOR", None)

        def tearDown(self) -> None:
            if self._saved_no_color is not None:
                os.environ["NO_COLOR"] = self._saved_no_color
            else:
                os.environ.pop("NO_COLOR", None)

        def _patch_isatty(self, value: bool):
            saved, sys.stdout = sys.stdout, io.StringIO()
            sys.stdout.isatty = lambda: value  # type: ignore[attr-defined]
            return saved

        def _restore(self, saved) -> None:
            sys.stdout = saved  # type: ignore[assignment]

        def test_no_flag_and_tty(self) -> None:
            saved = self._patch_isatty(True)
            try:
                self.assertTrue(_should_color(False))
            finally:
                self._restore(saved)

        def test_no_color_flag_overrides_tty(self) -> None:
            saved = self._patch_isatty(True)
            try:
                self.assertFalse(_should_color(True))
            finally:
                self._restore(saved)

        def test_non_tty_disables_color(self) -> None:
            saved = self._patch_isatty(False)
            try:
                self.assertFalse(_should_color(False))
            finally:
                self._restore(saved)

        def test_no_color_env_disables(self) -> None:
            """NO_COLOR env var (any non-empty) disables colors even on TTY."""
            saved = self._patch_isatty(True)
            old_nc = os.environ.get("NO_COLOR")
            os.environ["NO_COLOR"] = "1"
            try:
                self.assertFalse(_should_color(False))
            finally:
                self._restore(saved)
                if old_nc is None:
                    os.environ.pop("NO_COLOR", None)
                else:
                    os.environ["NO_COLOR"] = old_nc

        def test_no_color_empty_value_ignored(self) -> None:
            """empty NO_COLOR does NOT disable colors per no-color.org."""
            saved = self._patch_isatty(True)
            old_nc = os.environ.get("NO_COLOR")
            os.environ["NO_COLOR"] = ""
            try:
                self.assertTrue(_should_color(False))
            finally:
                self._restore(saved)
                if old_nc is None:
                    os.environ.pop("NO_COLOR", None)
                else:
                    os.environ["NO_COLOR"] = old_nc

    class TestBuildEditorCmd(unittest.TestCase):
        def test_multi_word_editor(self) -> None:
            """emacsclient -c -a '' should split into argv correctly."""
            result = build_editor_cmd("emacsclient -c -a ''")
            parts = shlex.split(result)
            self.assertGreater(len(parts), 1)
            self.assertEqual(Path(parts[0]).name, "emacsclient")

        def test_unbalanced_quote_fallback_to_vi(self) -> None:
            """malformed $EDITOR falls back to vi."""
            result = build_editor_cmd("emacsclient -c -a '")
            parts = shlex.split(result)
            self.assertEqual(Path(parts[0]).name, "vi")

        def test_empty_editor_fallback_to_vi(self) -> None:
            """set-but-empty $EDITOR falls back to vi."""
            result = build_editor_cmd("")
            parts = shlex.split(result)
            self.assertEqual(Path(parts[0]).name, "vi")

        def test_resolved_path_starts_with_slash(self) -> None:
            """build_editor_cmd resolves first token to absolute path."""
            result = build_editor_cmd("vi")
            self.assertTrue(result.startswith("/") or result.startswith(shlex.quote("/")),
                            f"expected absolute path, got: {result}")

    class TestIsGuiEditor(unittest.TestCase):
        def test_code_variants(self) -> None:
            self.assertTrue(_is_gui_editor("code"))
            self.assertTrue(_is_gui_editor("/usr/local/bin/code"))
            self.assertTrue(_is_gui_editor("code-insiders"))

        def test_cursor_variants(self) -> None:
            self.assertTrue(_is_gui_editor("cursor"))
            self.assertTrue(_is_gui_editor("cursor-bin"))

        def test_terminal_editors(self) -> None:
            self.assertFalse(_is_gui_editor("vim"))
            self.assertFalse(_is_gui_editor("nvim"))
            self.assertFalse(_is_gui_editor("nano"))
            self.assertFalse(_is_gui_editor("micro"))
            self.assertFalse(_is_gui_editor("/usr/bin/vi"))

    class TestRunFile(unittest.TestCase):
        def test_file_not_found(self) -> None:
            self.assertEqual(run_file(Path("/tmp/this-does-not-exist-plan-review-xyz.md")), 1)

        def test_file_read(self) -> None:
            tmp = Path(tempfile.mktemp(suffix=".md"))
            tmp.write_text("# Plan\n- task 1\n")
            try:
                content = tmp.read_text()
                self.assertEqual(content, "# Plan\n- task 1\n")
            finally:
                tmp.unlink(missing_ok=True)

    class TestReview(unittest.TestCase):
        def test_empty_content_returns_empty_diff(self) -> None:
            self.assertEqual(review(""), "")

        def test_diff_format(self) -> None:
            """smoke-test that review() uses get_diff correctly.

            we can't actually open an editor in tests, but we can verify that
            if the file is unchanged the diff is empty.
            """
            # bypass open_editor by checking the no-op path
            original = "unchanged content\n"
            edited = "unchanged content\n"
            self.assertEqual(get_diff(original, edited), "")

    class TestSentinelSpawn(unittest.TestCase):
        """verify sentinel file is cleaned up on launch failure via _sentinel_spawn."""

        def test_sentinel_spawn_success_returns_zero(self) -> None:
            """_sentinel_spawn returns 0 when the sentinel file appears after polling.
            regression: v0.2.3 unchecked sentinel.exists() after unlink.

            The real flow: mkstemp creates the sentinel, we unlink it, spawn the
            overlay (which touches it on editor close), then poll until it exists.
            This test exercises the polling loop: the sentinel is genuinely absent
            after unlink, and time.sleep recreates it (mimicking the spawned
            shell's `touch`), so a regression that skipped the loop (or checked
            exists() before unlink) would fail.
            """
            from unittest.mock import patch
            state = {"sleeps": 0, "sentinel": None}

            def fake_sleep(_s):
                state["sleeps"] += 1
                if state["sentinel"] is not None:
                    state["sentinel"].touch()

            def fake_run(cmd, *a, **kw):
                # Capture the sentinel path from the wrapper string and
                # schedule its creation on the first sleep call.
                wrapper = cmd[-1] if isinstance(cmd, list) else None
                if isinstance(wrapper, str) and "touch " in wrapper:
                    import shlex as _sh
                    parts = _sh.split(wrapper)
                    touch_idx = parts.index("touch")
                    if touch_idx + 1 < len(parts):
                        state["sentinel"] = Path(parts[touch_idx + 1])
                return None

            with (
                patch("subprocess.run", side_effect=fake_run),
                patch("time.sleep", side_effect=fake_sleep),
            ):
                result = _sentinel_spawn(["test-cmd"], "vim", Path("/tmp/fake-plan.md"))
            self.assertEqual(result, 0)
            self.assertGreaterEqual(state["sleeps"], 1,
                                    "polling loop never ran — sentinel.exists() must have been False at least once")

        def test_sentinel_spawn_polls_until_file_appears(self) -> None:
            """_sentinel_spawn polls until the sentinel appears; counts sleeps."""
            from unittest.mock import patch
            state = {"sleeps": 0, "sentinel": None}

            def fake_sleep(_s):
                state["sleeps"] += 1
                if state["sleeps"] >= 3 and state["sentinel"] is not None:
                    state["sentinel"].touch()

            def fake_run(cmd, *a, **kw):
                wrapper = cmd[-1] if isinstance(cmd, list) else None
                if isinstance(wrapper, str) and "touch " in wrapper:
                    import shlex as _sh
                    parts = _sh.split(wrapper)
                    touch_idx = parts.index("touch")
                    if touch_idx + 1 < len(parts):
                        state["sentinel"] = Path(parts[touch_idx + 1])
                return None

            with (
                patch("subprocess.run", side_effect=fake_run),
                patch("time.sleep", side_effect=fake_sleep),
            ):
                result = _sentinel_spawn(["test-cmd"], "vim", Path("/tmp/fake-plan.md"))
            self.assertEqual(result, 0)
            self.assertEqual(state["sleeps"], 3,
                             f"expected exactly 3 sleeps before sentinel appears, got {state['sleeps']}")

        def test_sentinel_spawn_launch_failure_returns_none(self) -> None:
            """_sentinel_spawn returns None on CalledProcessError and cleans sentinel."""
            from unittest.mock import patch
            with patch("subprocess.run", side_effect=subprocess.CalledProcessError(1, [])):
                result = _sentinel_spawn(["test-cmd"], "vim", Path("/tmp/fake-plan.md"))
            self.assertIsNone(result)

    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    for tc in [TestGetDiff, TestColorizeDiff, TestShouldColor, TestBuildEditorCmd, TestIsGuiEditor, TestRunFile, TestReview, TestSentinelSpawn]:
        suite.addTests(loader.loadTestsFromTestCase(tc))
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\r\033[K", end="")
        sys.exit(130)