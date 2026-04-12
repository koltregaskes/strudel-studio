@echo off
setlocal
cd /d "%~dp0.."
powershell -ExecutionPolicy Bypass -File scripts\run-release-smoke.ps1 %*
exit /b %ERRORLEVEL%
