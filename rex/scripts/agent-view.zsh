#!/bin/zsh
# Runs inside a Rex tab opened by the rex mod for one sub-agent.
#
# The mod writes what the agent does to numbered files in $1, one event each
# (00001.ev, 00002.ev, ...), already formatted for the terminal. This script
# prints them in order as they arrive, so the tab is a live log of the agent.
#
#   state   working | idle | done | error | aborted (the agent's loop now)
#   title   the agent's short description, for Rex's status reports
#
# The tab stays open after the agent ends: a message from SendMessage can
# resume it, and its events then carry on in the same tab. Close the tab when
# you've read it; the run directory is removed with it.

emulate -L zsh
setopt no_beep extended_glob

dir=$1
[[ -d $dir ]] || { print -u2 "rex: missing agent directory"; exit 2 }
trap 'rex_status clear; rm -rf -- $dir' EXIT
trap 'exit 0' INT TERM HUP

title=''
[[ -r $dir/title ]] && title=$(<$dir/title)

# Reports the agent's state to Rex with the Program Status Protocol (OSC 7501),
# so the tab shows it is working, finished, or failed.
b64() { print -rn -- "$1" | base64 | tr -d '\n' }
rex_status() {
  if [[ $1 == clear ]]; then
    printf '\e]7501;state=clear:app=rex-agent\e\\'
    return
  fi
  local msg=${2//[[:cntrl:]]/ }
  (( ${#msg} > 200 )) && msg="${msg[1,200]}…"
  printf '\e]7501;state=%s:app=rex-agent:title=%s:msg=%s\e\\' \
    "$1" "$(b64 "${title:-Claude sub-agent}")" "$(b64 "$msg")"
}

# Rex's own states for each of the agent's.
report() {
  case $1 in
    working) rex_status working "Working" ;;
    idle)    rex_status idle "Waiting for a message" ;;
    done)    rex_status done "Finished" ;;
    aborted) rex_status idle "Interrupted" ;;
    error)   rex_status error "Failed" ;;
  esac
}

integer n=1
shown=''
for (( ;; )); do
  # Events are printed strictly in order: one written out of order waits for
  # the one before it.
  f=$dir/${(l:5::0:)n}.ev
  if [[ -r $f ]]; then
    print -rn -- "$(<$f)"
    print
    (( n++ ))
    continue
  fi
  state=working
  [[ -r $dir/state ]] && state=$(<$dir/state)
  if [[ $state != $shown ]]; then
    report $state
    shown=$state
  fi
  [[ -d $dir ]] || exit 0
  sleep 0.25
done
