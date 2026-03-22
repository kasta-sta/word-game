const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Дозволити всім (для локал тунелю це необхідно)
        methods: ["GET", "POST"]
    }
});

app.use(express.static(path.join(__dirname, 'public')));

// === СТАН ===
const rooms = {};
const teams = {};
const rounds = {};

// Функція генерації літер
function generateLetters(word, playerCount) {
    let letters = word.toUpperCase().split('');
    while (letters.length < playerCount) {
        const randomLetter = letters[Math.floor(Math.random() * letters.length)];
        letters.push(randomLetter);
    }
    return letters.sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
    
    // 1. Гравець заходить у лобі
    socket.on('player_join', ({ roomCode, name }) => {
        if (!rooms[roomCode]) rooms[roomCode] = [];
        
        const player = { id: socket.id, name };
        rooms[roomCode].push(player);
        
        socket.join(roomCode);
        console.log(`👤 ${name} зайшов у ${roomCode}`);
        
        io.to(roomCode).emit('lobby_update', { players: rooms[roomCode] });
    });

    // 2. Адмін слідкує за лобі
    socket.on('admin_watch', ({ roomCode }) => {
        socket.join(roomCode);
        if (rooms[roomCode]) {
            socket.emit('lobby_update', { players: rooms[roomCode] });
        }
        if (teams[roomCode]) {
            socket.emit('teams_distributed', { teams: teams[roomCode] });
        }
        if (rounds[roomCode] && rounds[roomCode].active) {
            socket.emit('round_status', { 
                word: rounds[roomCode].word, 
                active: true,
                playerLetters: rounds[roomCode].playerLetters
            });
        }
        console.log(`👁️ Адмін слідкує за ${roomCode}`);
    });

    // 3. Розподіл команд
    socket.on('distribute_teams', ({ roomCode, teamCount }) => {
        if (!rooms[roomCode] || rooms[roomCode].length === 0) {
            socket.emit('error_msg', { msg: 'Немає гравців у лобі!' });
            return;
        }

        console.log(`🔄 Розподіл ${rooms[roomCode].length} гравців на ${teamCount} команд`);
        
        const players = [...rooms[roomCode]];
        const newTeams = {};
        
        for (let i = 0; i < teamCount; i++) {
            const teamName = `Team_${String.fromCharCode(65 + i)}`;
            newTeams[teamName] = [];
        }
        
        players.forEach((player, index) => {
            const teamIndex = index % teamCount;
            const teamName = `Team_${String.fromCharCode(65 + teamIndex)}`;
            
            const playerWithTeam = {
                ...player,
                team: teamName,
                number: newTeams[teamName].length + 1
            };
            
            newTeams[teamName].push(playerWithTeam);
            
            io.to(player.id).emit('team_assigned', {
                team: teamName,
                number: playerWithTeam.number
            });
        });
        
        teams[roomCode] = newTeams;
        io.to(roomCode).emit('teams_distributed', { teams: newTeams });
        console.log(`✅ Команди розподілено`);
    });

    // 4. Старт раунду
    socket.on('start_round', ({ roomCode, word }) => {
        if (!teams[roomCode]) {
            socket.emit('error_msg', { msg: 'Спочатку розподіліть команди!' });
            return;
        }

        if (!word || word.trim().length === 0) {
            socket.emit('error_msg', { msg: 'Введіть слово!' });
            return;
        }

        const cleanWord = word.trim().toUpperCase();
        console.log(`🎯 Раунд: "${cleanWord}"`);

        rounds[roomCode] = { word: cleanWord, active: true, playerLetters: {} };

        for (const teamName in teams[roomCode]) {
            const team = teams[roomCode][teamName];
            const letters = generateLetters(cleanWord, team.length);
            
            console.log(`   📦 ${teamName}: [${letters.join(', ')}]`);

            team.forEach((player, index) => {
                const letter = letters[index];
                
                rounds[roomCode].playerLetters[player.id] = {
                    name: player.name,
                    team: teamName,
                    number: player.number,
                    letter: letter
                };

                io.to(player.id).emit('round_started', {
                    letter: letter,
                    number: player.number,
                    team: teamName,
                    word: cleanWord
                });
            });
        }

        io.to(roomCode).emit('round_status', { 
            word: cleanWord, 
            active: true,
            playerLetters: rounds[roomCode].playerLetters
        });
    });

    // 🆕 5. ВАЛІДАЦІЯ КОДУ (нова функція)
    socket.on('submit_answer', ({ roomCode, team, code }) => {
        if (!rounds[roomCode] || !rounds[roomCode].active) {
            socket.emit('answer_result', { 
                success: false, 
                message: 'Раунд ще не активний!',
                team: team
            });
            return;
        }

        const targetWord = rounds[roomCode].word;
        const teamPlayers = teams[roomCode][team];
        
        if (!teamPlayers) {
            socket.emit('answer_result', { 
                success: false, 
                message: 'Команда не знайдена!',
                team: team
            });
            return;
        }

        console.log(`🧩 ${team} ввела код: "${code}"`);

        // Розбиваємо код на цифри (напр. "321" -> [3, 2, 1])
        const numbers = code.split('').map(n => parseInt(n.trim()));
        
        // Знаходимо літери для кожного номера
        const guessedLetters = numbers.map(num => {
            const player = teamPlayers.find(p => p.number === num);
            if (player) {
                const letterData = rounds[roomCode].playerLetters[player.id];
                return letterData ? letterData.letter : '?';
            }
            return '?';
        });

        const guessedWord = guessedLetters.join('');
        const isCorrect = guessedWord === targetWord;

        console.log(`   🔍 ${numbers.join('-')} -> "${guessedWord}" (ціль: "${targetWord}") ${isCorrect ? '✅' : '❌'}`);

        // 🆕 Відправляємо результат ВСІМ у кімнаті
        io.to(roomCode).emit('answer_result', {
            success: isCorrect,
            message: isCorrect ? '🎉 ПРАВИЛЬНО!' : '❌ Невірне слово',
            team: team,
            code: code,
            guessedWord: guessedWord,
            targetWord: targetWord,
            timestamp: new Date().toLocaleTimeString()
        });

        // Якщо правильно — можна завершити раунд
        if (isCorrect) {
            rounds[roomCode].active = false;
            rounds[roomCode].winner = team;
            io.to(roomCode).emit('round_ended', {
                winner: team,
                word: targetWord
            });
        }
    });

    // 🆕 6. НОВИЙ РАУНД (скидання попереднього)
    socket.on('new_round', ({ roomCode }) => {
        if (rounds[roomCode]) {
            rounds[roomCode].active = false;
        }
        io.to(roomCode).emit('round_reset');
        console.log(`🔄 Раунд скинуто для ${roomCode}`);
    });

    // 7. Гравець вийшов
    socket.on('disconnect', () => {
        for (const roomCode in rooms) {
            const initialLength = rooms[roomCode].length;
            rooms[roomCode] = rooms[roomCode].filter(p => p.id !== socket.id);
            
            if (rooms[roomCode].length !== initialLength) {
                io.to(roomCode).emit('lobby_update', { players: rooms[roomCode] });
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server on port ${PORT}`);
});