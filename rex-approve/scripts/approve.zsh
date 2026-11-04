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

# Runs $cmd, bracketed by markers the mod uses to cut each command's output
# out of the capture.
run_one() {
  (( runs++ ))
  print -r -- "$cmd" >| $dir/run.$runs.cmd
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
print -P "%F{8}Enter runs it here. Edit it first if you like. Ctrl-C or an empty line cancels.%f"
print

trap cancel INT
vared -e -p '%F{cyan}❯%f ' cmd || cancel
blank "$cmd" && cancel
run_one

share=''
while [[ -z $share ]]; do
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
