@echo off
echo ========================================
echo  RESET E INICIO - WhatsApp Monitor
echo ========================================
echo.

echo [1/3] Limpando autenticacao antiga...
if exist auth_info_baileys (
    rmdir /s /q auth_info_baileys
    echo    ✓ Autenticacao removida
) else (
    echo    ✓ Nenhuma autenticacao para remover
)
echo.

echo [2/3] Verificando pacotes...
call npm list baileys >nul 2>&1
if %errorlevel% neq 0 (
    echo    ! Instalando baileys...
    call npm install baileys@^6.7.8
) else (
    echo    ✓ Baileys instalado
)
echo.

echo [3/3] Iniciando WhatsApp Monitor...
echo.
echo ========================================
echo  Aguarde o QR Code aparecer
echo  Acesse: http://localhost:3001/qr
echo ========================================
echo.

npm start
