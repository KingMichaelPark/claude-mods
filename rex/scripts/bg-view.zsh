#!/bin/zsh
# Runs inside a Rex tab opened by the rex mod for one background Bash command.
#
# Claude Code runs the command (in its sandbox, as always) and writes its
# output to a file. This tab follows that file, so you can watch a dev server,
# a build or a test run live. The command does not run here.
#
# Files in $1, written by the mod:
#   command   the command as Claude ran it
#   title     Claude's description of it
#   output    the path of the output file to follow
#   exit      "<status> <code>" once Claude Code reports the task ended
#             (status is completed, failed, killed or stopped; code may be absent)
#
# Ctrl-C asks whether to stop the command. Closing the tab only stops watching.

emulate -L zsh
setopt no_beep no_bg_nice

dir=$1
[[ -d $dir && -r $dir/output ]] || { print -u2 "rex: missing run directory"; exit 2 }
out=$(<$dir/output)
cmd=''; [[ -r $dir/command ]] && cmd=$(<$dir/command)
title=''; [[ -r $dir/title ]] && title=$(<$dir/title)

b64() { print -rn -- "$1" | base64 | tr -d '\n' }
rex_status() {
  if [[ $1 == clear ]]; then
    printf '\e]7501;state=clear:app=rex-bg\e\\'
    return
  fi
  local msg=${2//[[:cntrl:]]/ }
  (( ${#msg} > 200 )) && msg="${msg[1,200]}…"
  printf '\e]7501;state=%s:app=rex-bg:title=%s:msg=%s\e\\' \
    "$1" "$(b64 "${title:-Background command}")" "$(b64 "$msg")"
}

tailpid=0
trap 'rex_status clear; (( tailpid )) && kill $tailpid 2>/dev/null; rm -rf -- $dir' EXIT
trap 'exit 0' TERM HUP

# The processes that still hold the output file open: the command and any
# children that inherited its output, but not this tab's tail.
holders() {
  local -a pids
  pids=(${(f)"$(lsof -t -- $out 2>/dev/null)"})
  print -r -- ${pids:#$tailpid}
}

ended=0
stop_prompt() {
  print
  if (( ended )); then
    print -P "%F{8}The command has ended. Close the tab to dismiss it.%f"
    return
  fi
  local -a pids
  pids=($(holders))
  if (( ${#pids} == 0 )); then
    print -P "%F{8}No running process found for this command.%f"
    return
  fi
  # Hold the output while you answer, so it doesn't print over the question.
  kill -STOP $tailpid 2>/dev/null
  print -Pn "%F{yellow}Stop the command (pids ${pids})? [y/N] %f"
  local key=''
  read -k1 -s key
  print
  kill -CONT $tailpid 2>/dev/null
  if [[ $key == [yY] ]]; then
    kill -TERM $pids 2>/dev/null
    print -P "%F{8}Sent SIGTERM. Claude will be told the command ended.%f"
  fi
}
trap stop_prompt INT

print -P "%B%F{cyan}\$ %f%b${cmd//\%/%%}"
[[ -n $title ]] && print -P "%F{8}${title//\%/%%}%f"
print -P "%F{8}Background command run by Claude. Ctrl-C to stop it; closing this tab only stops watching.%f"
print
rex_status working "Running"

# The command may not have written anything yet.
integer waited=0
while [[ ! -e $out ]] && (( waited++ < 20 )); do sleep 0.1; done
tail -n +1 -F -- $out 2>/dev/null &
tailpid=$!

integer misses=0 tick=0
shown=''
for (( ;; )); do
  sleep 0.5
  (( tick++ ))
  # The end as Claude Code reports it, with the exit code.
  if [[ -z $shown && -r $dir/exit ]]; then
    shown=$(<$dir/exit)
    ended=1
    sleep 0.3  # let tail print the last lines first
    local st=${shown%% *} rc=${shown#* }
    [[ $rc == $st ]] && rc=''
    print
    case $st in
      completed)
        if [[ -z $rc || $rc == 0 ]]; then
          print -P "%F{green}── Finished${rc:+ (exit $rc)} ──%f"; rex_status done "Finished"
        else
          print -P "%F{red}── Exited $rc ──%f"; rex_status error "Exited $rc"
        fi ;;
      failed) print -P "%F{red}── Failed${rc:+ (exit $rc)} ──%f"; rex_status error "Failed" ;;
      *)      print -P "%F{yellow}── Stopped ──%f"; rex_status idle "Stopped" ;;
    esac
  fi
  # Until then, notice the end ourselves: nobody holds the output file open.
  if (( ! ended && tick % 4 == 0 )); then
    if [[ -z "$(holders)" ]]; then
      (( ++misses >= 2 )) && { ended=1; rex_status idle "Ended"; }
    else
      misses=0
    fi
  fi
  [[ -d $dir ]] || exit 0
done
