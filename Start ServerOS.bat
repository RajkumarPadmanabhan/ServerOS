@echo off
title ServerOS
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo ServerOS needs Node.js 16 or newer.
  echo Download it from https://nodejs.org then double-click this file again.
  echo.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Setting up ServerOS. This needs an internet connection the first time.
  call npm install
  if errorlevel 1 (
    echo.
    echo Could not finish setup. Check your internet connection and try again.
    pause
    exit /b 1
  )
)
node src\index.js
echo.
echo ServerOS stopped. Your files are still saved.
echo Double-click this file to start again.
pause
