#!/bin/zsh
# Runs inside the short-lived Rex pane the rex mod opens for one command that
# Claude wants to run outside the sandbox.
#
# The command is shown in an editable prompt. You decide:
#   Enter            run it as shown (edit it first if you like)
#   Ctrl-O           move it into the editor (nvim when installed); saving and
#                    quitting runs the saved buffer, :cq or an empty buffer skips
#   Ctrl-C           skip it
#   "# some reason"  replace the command with a comment and press Enter: skip
#                    it, and Claude is told the reason
# A command with more than one line, or too tall for the pane, opens in the
# editor at once.
#
# The command runs here, in this terminal, as you, one time. The mod then reads
# its output with `rex capture`, closes the pane and removes $1.
#
# The mod puts these files in $1:
#   command        the command Claude proposed
#   description    Claude's description of it (optional)
#   who            the sub-agent that asked, when it was not Claude itself
# This script writes these files in $1:
#   status         ran | skipped
#   run.cmd        the command as it ran
#   rc             its exit status
#   interrupted    present when you pressed Ctrl-C while it ran
#   note           your reason for skipping (optional)

emulate -L zsh
setopt no_beep extended_glob

dir=$1
id=${2:-x}
[[ -d $dir && -r $dir/command ]] || { print -u2 "rex: missing run directory"; exit 2 }

cmd=$(<$dir/command)
why=''; [[ -r $dir/description ]] && why=$(<$dir/description)
who=''; [[ -r $dir/who ]] && who=$(<$dir/who)

# Reports this pane's state to Rex with the Program Status Protocol (OSC 7501):
# "blocked" lights the tab and notifies you, per Rex's notification settings.
b64() { print -rn -- "$1" | base64 | tr -d '\n' }
rex_status() {
  if [[ $1 == clear ]]; then
    printf '\e]7501;state=clear:app=rex-approve\e\\'
    return
  fi
  local msg=${${(f)3}[1]}
  msg=${msg//[[:cntrl:]]/ }
  (( ${#msg} > 200 )) && msg="${msg[1,200]}…"
  printf '\e]7501;state=%s:kind=%s:app=rex-approve:title=%s:msg=%s\e\\' \
    "$1" "$2" "$(b64 'Claude needs approval')" "$(b64 "$msg")"
}
trap 'rex_status clear' EXIT

finish() {
  print -r -- $1 >| $dir/status
  # The mod closes this pane and removes $dir. If it has not after a while
  # (it was reloaded, or its hook was stopped), the pane closes itself.
  if [[ -n $REX_BLOCK ]] && (( $+commands[rex] )); then
    ( sleep 20; [[ -d $dir ]] && rex block close $REX_BLOCK ) >/dev/null 2>&1 &!
  fi
  exit 0
}

# skip [reason]
skip() {
  [[ -n $1 ]] && print -r -- "$1" >| $dir/note
  print
  print -P "%F{8}Skipped. Claude is told you did not run it.%f"
  finish skipped
}

blank() { [[ -z ${1//[[:space:]]/} ]] }

# Skips when $cmd is empty or is only comments; the comments are your reason.
skip_if_note() {
  blank "$cmd" && skip
  local line
  local -a note
  for line in "${(@f)cmd}"; do
    blank "$line" && continue
    [[ $line == [[:space:]]#\#* ]] || return 0
    line=${line##[[:space:]]#\#[[:space:]]#}
    note+=("$line")
  done
  skip "${(F)note}"
}

# Whether $cmd is one line that fits on screen for the inline prompt.
fits() {
  [[ $cmd == *$'\n'* ]] && return 1
  local -i h=24 w=80
  local size
  size=$(stty size 2>/dev/null) && { h=${size% *}; w=${size#* } }
  (( w > 0 )) || w=80
  (( (${#cmd} + 2) / w + 1 <= h - 6 ))
}

if (( $+commands[nvim] )); then
  editor=nvim
else
  editor=${VISUAL:-${EDITOR:-vi}}
fi

# Edits $cmd in the editor. The saved buffer is what runs.
edit_in_editor() {
  local f=$dir/command.zsh
  print -r -- "$cmd" >| $f
  local -a hint
  [[ ${editor:t} == (nvim|vim)* ]] &&
    hint=(-c 'echo ":wq runs the saved buffer   :cq skips   only # comments: skips and tells Claude why"')
  ${=editor} $hint $f </dev/tty >/dev/tty || skip  # :cq
  cmd=$(<$f)
}

# Edits $cmd in place. Enter accepts; Ctrl-O moves it into the editor.
integer want_editor=0
to_editor() { want_editor=1; zle accept-line }
zle -N to_editor
for km in emacs viins vicmd; do
  bindkey -M $km '^O' to_editor
  bindkey -M $km '^X^E' to_editor
done
# In the vi insert keymap these keys stop at the point where insert mode
# began, which is the end of the proposed command: make them edit all of it.
bindkey -M viins '^?' backward-delete-char
bindkey -M viins '^H' backward-delete-char
bindkey -M viins '^W' backward-kill-word
bindkey -M viins '^U' backward-kill-line
edit_inline() {
  want_editor=0
  vared -e -p '%F{cyan}❯%f ' cmd || skip
  (( want_editor )) && edit_in_editor
}

# Runs $cmd one time, between markers the mod uses to cut its output out of
# the capture.
run_it() {
  print -r -- "$cmd" >| $dir/run.cmd
  rex_status clear  # the command may report its own status
  trap ': >| $dir/interrupted' INT  # Ctrl-C stops the command, not this script
  print -P "%F{8}⟦rex:${id}:begin⟧%f"
  ( eval "$cmd" )
  local rc=$?
  print
  print -P "%F{8}⟦rex:${id}:end⟧%f"
  trap '' INT
  print -r -- $rc >| $dir/rc
}

if [[ -n $who ]]; then
  print -P "%B%F{yellow}Sub-agent ${who//\%/%%} wants to run this outside the sandbox%f%b"
else
  print -P "%B%F{yellow}Claude wants to run this outside the sandbox%f%b"
fi
[[ -n $why ]] && print -P "%F{8}${why//\%/%%}%f"
print -P "%F{8}cwd: ${PWD//\%/%%}%f"

rex_status blocked permission "$cmd"
trap skip INT
if fits; then
  print -P "%F{cyan}Enter%F{8} runs it · %F{cyan}Ctrl-O%F{8} edits in ${editor//\%/%%} · %F{cyan}Ctrl-C%F{8} skips · %F{cyan}# reason%F{8} skips and tells Claude why%f"
  print
  edit_inline
else
  edit_in_editor
  print -P "%F{cyan}❯%f"
  print -r -- "$cmd"
fi
skip_if_note

run_it
finish ran
