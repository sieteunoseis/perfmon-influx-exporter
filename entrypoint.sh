#!/bin/sh

if [ "$1" = "start" ]; then
    node main.js start
elif [ "$1" = "config" ]; then
    NODE_ENV=development node main.js config -s "$2" -o "$3" ${4:+--counters "$4"}
else
    echo "Invalid command: $1"
    exit 1
fi