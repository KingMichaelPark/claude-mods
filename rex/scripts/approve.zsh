#!/bin/zsh
# Runs inside a Rex pane opened by the rex mod.
#
# Shows the command Claude wants to run. You can run it as it is, edit it
# first, or cancel. It runs here, in this terminal, as you, one time. The
# result goes back to Claude. In auto mode the pane then closes; otherwise it
# stays open for you to read and close.
#
# Ctrl-C at any point (before the command runs, while it runs, or after it)
# sends nothing: the mod ends Claude's turn and Claude waits for you.
#
# The mod puts these files in $1 for the wrapper to read:
#   command        the command Claude proposed
#   description    Claude's description of it (optional)
#   automode       present when Claude Code is in auto mode
#   autorun        present when you chose auto-run in auto mode: the command
#                  runs at once, with no questions
# The wrapper writes these files in $1 for the mod to read:
#   status         ran | cancelled (not run) | stopped (Ctrl-C after it started)
#   run.cmd        the command as you ran it (it can be edited)
#   rc             its exit status
#   note           a note you typed for Claude (optional)
#   always         present when you chose "auto-run from now on in auto mode"
# The output is not written to a file. The mod reads it with
# `rex block capture`.

emulate -L zsh
setopt no_beep

dir=$1
id=${2:-x}
[[ -d $dir && -r $dir/command ]] || { print -u2 "rex: missing run directory"; exit 2 }

cmd=$(<$dir/command)
why=''
[[ -r $dir/description ]] && why=$(<$dir/description)
automode=0
[[ -e $dir/automode ]] && automode=1
autorun=0
[[ -e $dir/autorun ]] && autorun=1

finish() {
  print -r -- $1 >| $dir/status
  # In auto mode the mod reads this pane's output, then closes it and removes
  # $dir. If it has not done so after a while (it was reloaded, or its hook
  # was stopped), the pane closes itself. Out of auto mode, a pane whose
  # command ran stays open for you to read and close.
  if (( automode )) && [[ -n $REX_BLOCK ]] && (( $+commands[rex] )); then
    ( sleep 20; [[ -d $dir ]] && rex block close $REX_BLOCK ) >/dev/null 2>&1 &!
  fi
  exit 0
}

# Ctrl-C (or n, or an empty command) before the command runs.
cancel() {
  print
  print -P "%F{8}Not run. Claude stops and waits for you.%f"
  finish cancelled
}

# Ctrl-C after the command started.
stopped() {
  print
  print -P "%F{8}Stopped. Nothing goes to Claude. Claude stops and waits for you.%f"
  finish stopped
}

blank() { [[ -z ${1//[[:space:]]/} ]] }

# Reports this pane's state to Rex with the Program Status Protocol (OSC 7501).
# "blocked" lights the tab, plays Rex's blocked sound, and sends a macOS
# notification when Rex is in the background (all per Rex's Settings >
# Notifications > Program Activity). "clear" removes the report.
#   rex_status blocked <kind> <message> | rex_status clear
b64() { print -rn -- "$1" | base64 | tr -d '\n' }
rex_status() {
  if [[ $1 == clear ]]; then
    printf '\e]7501;state=clear:app=rex-approve\e\\'
    return
  fi
  # One line, no control characters, kept well under the 2048-byte limit.
  local msg=${${(f)3}[1]}
  msg=${msg//[[:cntrl:]]/ }
  (( ${#msg} > 200 )) && msg="${msg[1,200]}…"
  printf '\e]7501;state=%s:kind=%s:app=rex-approve:title=%s:msg=%s\e\\' \
    "$1" "$2" "$(b64 'Claude needs approval')" "$(b64 "$msg")"
}
trap 'rex_status clear' EXIT

# Whether $cmd fits on screen for vared. zle can't show a buffer taller than
# the terminal, so a longer one is printed in full (scrollable) and edited in
# an editor.
fits() {
  local -i rows=0 h=24 w=80
  local size line
  size=$(stty size 2>/dev/null) && { h=${size% *}; w=${size#* } }
  (( w > 0 )) || w=80
  for line in "${(@f)cmd}"; do
    (( rows += (${#line} + 2) / w + 1 ))  # +2 for the "❯ " prompt
  done
  (( rows <= h - 4 ))
}

if (( $+commands[nvim] )); then
  editor=nvim
else
  editor=${VISUAL:-${EDITOR:-vi}}
fi

# Edits $cmd in $editor. An empty result cancels.
edit_in_editor() {
  print -r -- "$cmd" >| $dir/edit.zsh
  ${=editor} $dir/edit.zsh </dev/tty >/dev/tty
  cmd=$(<$dir/edit.zsh)
  rm -f $dir/edit.zsh
  blank "$cmd" && cancel
}

# Edits $cmd in place. Enter accepts the edit and runs it.
edit_inline() {
  vared -e -p '%F{cyan}❯%f ' cmd || cancel
}

# A one-key menu. Used in auto mode (for the auto-run choice) and for commands
# too tall to edit in place. Returns when the command must run.
choose() {
  local key long
  for (( ;; )); do
    long=0
    fits || long=1
    print -P "%F{cyan}❯%f"
    print -r -- "$cmd"
    print
    (( long )) && print -P "%F{8}Too long to edit in place. Scroll up to read all of it.%f"
    print -P "  %F{cyan}Enter%f  run it"
    if (( long )); then
      print -P "  %F{cyan}e%f      edit it in ${editor//\%/%%}"
    else
      print -P "  %F{cyan}e%f      edit it here (Enter then runs it)"
    fi
    (( automode )) && print -P "  %F{cyan}a%f      run it, and auto-run all commands from now on in auto mode"
    print -P "  %F{cyan}n%f      cancel (or Ctrl-C)"
    key=''
    while [[ -z $key ]]; do
      read -k1 -s key || cancel
      case $key in
        $'\n'|$'\r') return 0 ;;
        n|N) cancel ;;
        a|A)
          if (( automode )); then
            : >| $dir/always
            return 0
          fi
          key=''
          ;;
        e|E)
          print
          if (( long )); then
            edit_in_editor
            print
          else
            edit_inline
            return 0
          fi
          ;;
        *) key='' ;;
      esac
    done
  done
}

# Runs $cmd one time, bracketed by markers the mod uses to cut its output out
# of the capture.
run_it() {
  print -r -- "$cmd" >| $dir/run.cmd
  rex_status clear  # the command may report its own status
  local -i interrupted=0
  trap 'interrupted=1' INT  # Ctrl-C stops the command; checked below
  print -P "%F{8}⟦rex:${id}:begin:1⟧%f"
  ( eval "$cmd" )
  local rc=$?
  print -P "%F{8}⟦rex:${id}:end:1⟧%f"
  trap stopped INT
  # A program that handles Ctrl-C itself and exits 0 was not stopped.
  (( interrupted && rc != 0 )) && stopped
  print -r -- $rc >| $dir/rc
  print
  if (( rc == 0 )); then print -P "%F{green}Exited 0.%f"; else print -P "%F{red}Exited ${rc}.%f"; fi
}

# Before the result goes to Claude: w adds a note, Enter sends now, any other
# key holds the pane until you choose. Sends by itself after 5 seconds.
offer_note() {
  local key='' n
  rex_status blocked question "Sending the result to Claude"
  print -P "%F{8}Sends to Claude in 5s. %F{cyan}w%F{8} adds a note first. Enter sends now. Any other key waits. Ctrl-C sends nothing.%f"
  for (( n = 5; n > 0; n-- )); do
    read -k1 -s -t 1 key && break
  done
  case $key in
    ''|$'\n'|$'\r'|w|W) ;;
    *)
      print -P "%F{8}Waiting. %F{cyan}w%F{8} adds a note. Enter sends.%f"
      key=''
      while [[ -z $key ]]; do
        read -k1 -s key || { key=$'\n'; break }
        case $key in
          $'\n'|$'\r'|w|W) ;;
          *) key='' ;;
        esac
      done
      ;;
  esac
  if [[ $key == [wW] ]]; then
    local note=''
    print
    vared -p '%F{cyan}note❯%f ' note
    blank "$note" || print -r -- "$note" >| $dir/note
  fi
}

print -P "%B%F{yellow}Claude wants to run a command that needs your approval%f%b"
[[ -n $why ]] && print -P "%F{8}${why//\%/%%}%f"
print -P "%F{8}cwd: ${PWD//\%/%%}%f"

if (( autorun )); then
  print -P "%F{8}Auto mode: it runs without asking. %F{cyan}/rex approve auto off%F{8} stops this.%f"
  print -P "%F{cyan}❯%f"
  print -r -- "$cmd"
  print
else
  rex_status blocked permission "$cmd"
  trap cancel INT
  if (( automode )) || ! fits; then
    print
    choose
  else
    print -P "%F{8}Enter runs it here. Edit it first if you like. Ctrl-C or an empty line cancels.%f"
    print
    edit_inline
  fi
  blank "$cmd" && cancel
fi

run_it
(( autorun )) || offer_note
if (( automode )); then
  print -P "%F{8}Sent to Claude. This pane closes now.%f"
else
  print -P "%F{8}Sent to Claude. Close this pane when you're done with it.%f"
fi
finish ran
