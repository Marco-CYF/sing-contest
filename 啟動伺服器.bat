@echo off
chcp 65001 >NUL
cd /d "%~dp0"
where node >NUL 2>NUL || (echo 找不到 Node.js，請先到 https://nodejs.org 安裝 LTS 版本 & pause & exit /b)
node server.js
pause
