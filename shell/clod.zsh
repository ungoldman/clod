# Wraps the clod bin so the shell cds to the resumed session's project
# directory after claude exits. A child process can't change its parent
# shell's cwd, so the bin reports the path over fd 3 and this function,
# running inside the shell, does the cd. Source from .zshrc:
#
#   source /path/to/clod/shell/clod.zsh
#
# Without this, the bin still works; you just stay in the launch directory.
#
# Plumbing: fd 3 feeds the command substitution; the TUI goes to stderr's
# terminal via 1>&2. Don't use 1>/dev/tty here: the resumed claude inherits
# that fd, and Bun-built binaries crash on macOS trying to kqueue /dev/tty
# (EINVAL) — kqueue can't poll the controlling-terminal alias device.
clod() {
  local dir
  dir="$(CLOD_CWD_FD=3 command clod "$@" 3>&1 1>&2)"
  [[ -n "$dir" && -d "$dir" ]] && cd "$dir"
}
