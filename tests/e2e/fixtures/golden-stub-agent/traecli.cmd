@echo off
setlocal
set "GOLDEN_STUB_AGENT_REPORT_ARGS=1"
call "%~dp0golden-stub-agent.cmd" %*
endlocal
