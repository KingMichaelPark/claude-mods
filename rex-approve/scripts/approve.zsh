#!/bin/zsh
# Runs inside a Rex pane opened by the rex-approve mod.
#
# Shows the command Claude wants to run, prefilled and editable. Enter runs it
# here, in this terminal, as you. Ctrl-C (or an empty line) cancels. After it
# runs you can keep going with follow-on commands, then choose what Claude is
# told about the result.
#
# Everything the mod reads back is written to files in $1:
#   status         ran | cancelled
#   runs           how many commands ran
#   run.N.cmd      command N as you ran it (N from 1; 1 may be edited)
#   run.N.rc       its exit status
#   share          output | code | summary
#   summary        your own words, when share is "summary"
# The output itself is never written to a file: the mod reads it with
# `rex block capture`, and only when share is "output".

emulate -L zsh
setopt no_beep

dir=$1
id=${2:-x}
[[ -d $dir && -r $dir/command ]] || { print -u2 "rex-approve: missing run directory"; exit 2 }

cmd=$(<$dir/command)
why=''
[[ -r $dir/description ]] && why=$(<$dir/description)
runs=0

cancel() {
  print
  print -P "%F{8}Cancelled. Claude will be told you didn't run it.%f"
  print -r -- cancelled >| $dir/status
  exit 0
}

# Once anything has run, Ctrl-C at the menu shares the exit codes alone.
code_only() {
  print -r -- code >| $dir/share
  print -r -- ran >| $dir/status
  exit 0
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
# the terminal, so a longer one is printed in full instead (scrollable) and
# edited in $EDITOR.
fits() {
  local -i rows=0 h=24 w=80
  local size line
  size=$(stty size 2>/dev/null) && { h=${size% *}; w=${size#* } }
  (( w > 0 )) || w=80
  for line in "${(@f)cmd}"; do
    (( rows += (${#line} + 2) / w + 1 ))  # +2 for the "❯ " prompt
  done
  (( rows <= h - 2 ))
}

editor=${VISUAL:-${EDITOR:-vi}}

# For a command too tall for vared: shows all of it, then Enter runs it,
# e edits it in $editor, Ctrl-C or n cancels.
confirm_long() {
  local key
  for (( ;; )); do
    print -P "%F{cyan}❯%f"
    print -r -- "$cmd"
    print
    print -P "%F{8}Too long to edit in place. Scroll up to read all of it.%f"
    print -P "%F{8}Enter runs it. %F{cyan}e%F{8} edits it in ${editor//\%/%%}. Ctrl-C or %F{cyan}n%F{8} cancels.%f"
    key=''
    while [[ -z $key ]]; do
      read -k1 -s key || cancel
      case $key in
        $'\n'|$'\r') return 0 ;;
        n|N) cancel ;;
        e|E)
          print -r -- "$cmd" >| $dir/edit.zsh
          ${=editor} $dir/edit.zsh </dev/tty >/dev/tty
          cmd=$(<$dir/edit.zsh)
          rm -f $dir/edit.zsh
          blank "$cmd" && cancel
          print
          ;;
        *) key='' ;;
      esac
    done
  done
}

# Runs $cmd, bracketed by markers the mod uses to cut each command's output
# out of the capture.
run_one() {
  (( runs++ ))
  print -r -- "$cmd" >| $dir/run.$runs.cmd
  rex_status clear  # the command may report its own status
  trap ': ' INT  # Ctrl-C interrupts the command, not this wrapper
  print -P "%F{8}⟦rex-approve:${id}:begin:${runs}⟧%f"
  ( eval "$cmd" )
  local rc=$?
  print -P "%F{8}⟦rex-approve:${id}:end:${runs}⟧%f"
  print -r -- $rc >| $dir/run.$runs.rc
  print -r -- $runs >| $dir/runs
  trap code_only INT
  print
  if (( rc == 0 )); then print -P "%F{green}Exited 0.%f"; else print -P "%F{red}Exited ${rc}.%f"; fi
}

print -P "%B%F{yellow}Claude wants to run a command that needs your approval%f%b"
[[ -n $why ]] && print -P "%F{8}${why//\%/%%}%f"
print -P "%F{8}cwd: ${PWD//\%/%%}%f"
rex_status blocked permission "$cmd"

trap cancel INT
if fits; then
  print -P "%F{8}Enter runs it here. Edit it first if you like. Ctrl-C or an empty line cancels.%f"
  print
  vared -e -p '%F{cyan}❯%f ' cmd || cancel
else
  print
  confirm_long
fi
blank "$cmd" && cancel
run_one

share=''
while [[ -z $share ]]; do
  rex_status blocked question "Choose what to send Claude"
  print -P "%BWhat next?%b"
  print -P "  %F{cyan}k%f  keep going: run a follow-on command here"
  print -P "  %F{cyan}y%f  send Claude the captured output"
  print -P "  %F{cyan}c%f  send only the exit code$( (( runs > 1 )) && print s)"
  print -P "  %F{cyan}w%f  send a summary I write"
  key=''
  while [[ -z $key ]]; do
    read -k1 -s key || key=c
    case $key in
      k|K|y|Y|c|C|w|W) ;;
      *) key='' ;;
    esac
  done
  case $key in
    k|K)
      cmd=''
      print
      print -P "%F{8}Follow-on command. Ctrl-C or an empty line goes back.%f"
      # Any interrupted vared ends the script it runs in, so it runs in a
      # subshell that Ctrl-C may end, while this script ignores the signal
      # and comes back to the menu. The command comes back through a file.
      rm -f $dir/next
      trap ': ' INT
      ( trap - INT; vared -e -p '%F{cyan}❯%f ' cmd && print -r -- "$cmd" >| $dir/next )
      trap code_only INT
      cmd=''
      [[ -r $dir/next ]] && cmd=$(<$dir/next)
      rm -f $dir/next
      if ! blank "$cmd"; then
        run_one
      else
        trap code_only INT
        print
      fi
      ;;
    y|Y) share=output ;;
    c|C) share=code ;;
    w|W) share=summary ;;
  esac
done

if [[ $share == summary ]]; then
  summary=''
  trap ': ' INT
  print
  vared -p '%F{cyan}summary❯%f ' summary || summary=''
  print -r -- "$summary" >| $dir/summary
fi

print -r -- $share >| $dir/share
print -r -- ran >| $dir/status
print -P "%F{8}Sent to Claude ($share). This pane closes now.%f"
exit 0
