@echo off
echo ========================================
echo  Reset WhatsApp Authentication
echo ========================================
echo.

echo [1/4] Parando processos Node.js...
taskkill /F /IM node.exe 2>nul
timeout /t 2 /nobreak >nul

echo [2/4] Removendo autenticacao antiga...
if exist "auth_info_baileys" (
    rmdir /s /q "auth_info_baileys"
    echo Autenticacao removida com sucesso
) else (
    echo Nenhuma autenticacao encontrada
)

echo [3/4] Limpando cache do npm...
call npm cache clean --force

echo [4/4] Reiniciando servidor...
echo.
echo Aguarde o QR Code aparecer...
echo.
start /B npm start

echo.
echo ========================================
echo  Reinicio concluido!
echo ========================================
