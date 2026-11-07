import asyncio

import websockets

# O "0.0.0.0" faz o servidor aceitar conexões de outros dispositivos na rede
HOST = "0.0.0.0"
PORT = 8080  # A mesma porta que você colocará no código do ESP32

async def echo(websocket):
    print(f"✅ ESP32 conectado de: {websocket.remote_address}")
    try:
        async for message in websocket:
            print(f"📩 Recebido do ESP32: {message}")
            # O 'echo' devolve a mesma mensagem para o ESP32
            await websocket.send(f"Servidor recebeu: {message}")
    except websockets.exceptions.ConnectionClosed:
        print("🔌 ESP32 desconectado.")

async def main():
    async with websockets.serve(echo, HOST, PORT):
        print(f"🚀 Servidor WebSocket rodando em ws://0.0.0.0:{PORT}")
        print("Aguardando conexão do ESP32...")
        await asyncio.Future()  # Mantém o servidor rodando para sempre

if __name__ == "__main__":
    asyncio.run(main())
