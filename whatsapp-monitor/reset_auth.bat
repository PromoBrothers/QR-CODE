@echo off
echo 🔄 Limpando autenticacao do WhatsApp...
echo.

REM Parar o servidor se estiver rodando
taskkill /F /IM node.exe 2>nul

REM Aguardar 2 segundos
timeout /t 2 /nobreak >nul

REM Remover pasta de autenticacao
if exist auth_info_baileys (
    echo 🗑️ Removendo pasta auth_info_baileys...
    rmdir /s /q auth_info_baileys
    echo ✅ Autenticacao removida com sucesso!
) else (
    echo ⚠️ Pasta auth_info_baileys nao encontrada
)

echo.
echo ✅ Pronto! Agora execute: npm start
echo.
echo 📱 Um novo QR Code sera gerado automaticamente
pause
