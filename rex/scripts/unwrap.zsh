#!/bin/zsh -f
# Prints the command inside a `rex split … -- COMMAND` or `rex run … -- COMMAND`
# call, ready to run in a shell. Exits 1 when $1 is not such a call.
#
# Claude sometimes wraps a command that must leave the sandbox in its own
# `rex split`. The approval pane is already a split, so the mod runs the inner
# command there and does not open a second pane.
#
# Bails out (exit 1) when it cannot be sure: another server (-S), no `--`, or
# shell operators (; && || | &) outside the quoted command.

emulate -L zsh
setopt extended_glob

local -a w
w=(${(z)1})
(( $#w >= 4 )) || exit 1
[[ ${(Q)w[1]} == (|*/)rex ]] || exit 1
[[ ${(Q)w[2]} == (split|run) ]] || exit 1

integer i sep=0
local cwd=''
for (( i = 3; i <= $#w; i++ )); do
  case ${(Q)w[i]} in
    --) sep=i; break ;;
    -S|--server|--server=*|-S?*) exit 1 ;;
    -c|--cwd) cwd=${w[i+1]}; (( i++ )) ;;
    --cwd=*) cwd=${w[i]#--cwd=} ;;
  esac
done
(( sep > 0 && sep < $#w )) || exit 1

# A shell operator anywhere at the top level: the call is part of a bigger
# command, so leave it alone.
local t
for t in $w; do
  [[ $t == (\;|\;\;|\&|\&\&|\|\||\||\|\&|\&\!|\&\|) ]] && exit 1
done

local -a argv_
argv_=(${w[sep+1,-1]})
local inner
# `sh -c SCRIPT`, `bash -lc SCRIPT` and the like: run SCRIPT itself.
if (( $#argv_ == 3 )) && [[ ${(Q)argv_[1]:t} == (sh|bash|zsh) && ${(Q)argv_[2]} == -(l|)c ]]; then
  inner=${(Q)argv_[3]}
else
  # The words are shell syntax already: keep them as written.
  inner=${(j: :)argv_}
fi
[[ -n ${inner//[[:space:]]/} ]] || exit 1
[[ -n $cwd ]] && inner="cd $cwd && $inner"
print -r -- $inner
