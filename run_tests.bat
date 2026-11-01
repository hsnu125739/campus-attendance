@echo off
"C:\Users\wl020\AppData\Local\Python\pythoncore-3.14-64\Lib\site-packages\playwright\driver\node.exe" build.js
if errorlevel 1 goto failed
"C:\Users\wl020\AppData\Local\Python\pythoncore-3.14-64\Lib\site-packages\playwright\driver\node.exe" test_campus_domain.js
if errorlevel 1 goto failed
"C:\Users\wl020\AppData\Local\Python\pythoncore-3.14-64\Lib\site-packages\playwright\driver\node.exe" test_repository.js
if errorlevel 1 goto failed
"C:\Users\wl020\AppData\Local\Python\pythoncore-3.14-64\Lib\site-packages\playwright\driver\node.exe" test_attendance_store.js
if errorlevel 1 goto failed
"C:\Users\wl020\AppData\Local\Python\pythoncore-3.14-64\Lib\site-packages\playwright\driver\node.exe" test_member_sync.js
if errorlevel 1 goto failed
"C:\Users\wl020\AppData\Local\Python\pythoncore-3.14-64\Lib\site-packages\playwright\driver\node.exe" test_campus_store.js
if errorlevel 1 goto failed
"C:\Users\wl020\AppData\Local\Python\pythoncore-3.14-64\Lib\site-packages\playwright\driver\node.exe" test_concurrency_probing.js
if errorlevel 1 goto failed
"C:\Users\wl020\AppData\Local\Python\pythoncore-3.14-64\Lib\site-packages\playwright\driver\node.exe" test_stats_aggregator.js
if errorlevel 1 goto failed
echo.
echo ========================================================
echo  Build + All offline unit tests (Backend + Frontend) PASSED!
echo ========================================================
pause
exit /b 0
:failed
echo.
echo ========================================================
echo  Build or Tests FAILED! Please check the output above.
echo ========================================================
pause
exit /b 1
