#!/bin/bash

# make sure we are on root
if [ ! -f "package.json" ]; then
  echo "Please run this script from the root of the project"
  exit 1
fi

npm update @zen-browser/surfer
npm i @zen-browser/surfer@latest
