@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Etherhaze - emulateur Ether Dream
if not exist node_modules (
  echo Premiere installation...
  call npm install
)
node server.js
pause
