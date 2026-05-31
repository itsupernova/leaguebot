import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import axios from 'axios'
import sharp from 'sharp'
import Database from 'better-sqlite3'
import {
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} from 'discord.js'
import { evaluateTexasHoldem, compareHands } from './evaluator.js'

const API = process.env.API_BASE_URL
const BOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT_DIR = path.resolve(BOT_DIR, '..')
const DATA_DIR = path.join(BOT_DIR, 'data', 'poker')
const RENDER_DIR = path.join(DATA_DIR, 'renders')
const DB_PATH = path.join(DATA_DIR, 'poker.sqlite')
const CARD_DIR = path.join(ROOT_DIR, 'cards')

const CONFIG = {
    prefix: '?',
    maxPlayers: Number(process.env.POKER_MAX_PLAYERS || 6),
    minPlayers: 2,
    buyIn: Number(process.env.POKER_BUY_IN || 100),
    smallBlind: Number(process.env.POKER_SMALL_BLIND || 10),
    bigBlind: Number(process.env.POKER_BIG_BLIND || 20),
    turnSeconds: Number(process.env.POKER_TURN_SECONDS || 60),
    inactivityMinutes: Number(process.env.POKER_INACTIVITY_MINUTES || 30)
}

const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' }
const PHASES = ['preflop', 'flop', 'turn', 'river']
const PHASE_LABEL = { lobby: 'Lobby', preflop: 'Pre-Flop', flop: 'Flop', turn: 'Turn', river: 'River', showdown: 'Showdown', ended: 'Ended' }

const tables = new Map()
let db

const log = (level, message, meta = {}) => {
    console[level === 'error' ? 'error' : 'log'](JSON.stringify({
        scope: 'poker',
        level,
        message,
        ...meta,
        time: new Date().toISOString()
    }))
}

const ensureStorage = () => {
    fs.mkdirSync(RENDER_DIR, { recursive: true })
    db = new Database(DB_PATH)
    db.pragma('journal_mode = WAL')
    db.exec(`
        CREATE TABLE IF NOT EXISTS games (
            game_id TEXT PRIMARY KEY,
            channel_id TEXT NOT NULL,
            message_id TEXT,
            phase TEXT NOT NULL,
            pot INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            state_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS game_players (
            game_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            cards TEXT,
            current_bet INTEGER NOT NULL DEFAULT 0,
            folded INTEGER NOT NULL DEFAULT 0,
            all_in INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (game_id, user_id)
        );
    `)
}

const saveTable = (table) => {
    table.updatedAt = new Date().toISOString()
    db.prepare(`
        INSERT INTO games (game_id, channel_id, message_id, phase, pot, created_at, updated_at, state_json)
        VALUES (@id, @channelId, @messageId, @phase, @pot, @createdAt, @updatedAt, @stateJson)
        ON CONFLICT(game_id) DO UPDATE SET
            channel_id = excluded.channel_id,
            message_id = excluded.message_id,
            phase = excluded.phase,
            pot = excluded.pot,
            updated_at = excluded.updated_at,
            state_json = excluded.state_json
    `).run({
        id: table.id,
        channelId: table.channelId,
        messageId: table.messageId || null,
        phase: table.phase,
        pot: table.pot,
        createdAt: table.createdAt,
        updatedAt: table.updatedAt,
        stateJson: JSON.stringify(stripRuntime(table))
    })

    const replace = db.transaction(() => {
        db.prepare('DELETE FROM game_players WHERE game_id = ?').run(table.id)
        const insert = db.prepare(`
            INSERT INTO game_players (game_id, user_id, cards, current_bet, folded, all_in)
            VALUES (?, ?, ?, ?, ?, ?)
        `)
        for (const player of table.players) {
            insert.run(table.id, player.id, JSON.stringify(player.cards || []), player.currentBet, player.folded ? 1 : 0, player.allIn ? 1 : 0)
        }
    })
    replace()
}

const deleteTable = (table) => {
    clearTurnTimer(table)
    db.prepare('DELETE FROM game_players WHERE game_id = ?').run(table.id)
    db.prepare('DELETE FROM games WHERE game_id = ?').run(table.id)
    tables.delete(table.channelId)
}

const stripRuntime = (table) => {
    const { timer, client, ...safe } = table
    return safe
}

const restoreTables = () => {
    for (const row of db.prepare('SELECT state_json FROM games WHERE phase != ?').all('ended')) {
        try {
            const table = JSON.parse(row.state_json)
            table.timer = null
            tables.set(table.channelId, table)
        } catch (err) {
            log('error', 'Failed to restore poker table', { error: err.message })
        }
    }
}

const publicName = (user) => user.globalName || user.username || user.displayName || user.id

const renderCardSvg = (card, width = 120, height = 168) => {
    const red = ['H', 'D'].includes(card.suit)
    const label = card.back ? '' : `${card.rank}${SUIT_SYMBOL[card.suit]}`
    const fill = card.back ? '#1f3b7a' : '#f8fafc'
    const stroke = card.back ? '#d4af37' : '#1f2937'
    const color = red ? '#dc2626' : '#111827'
    const center = card.back ? 'REQU' : label
    return Buffer.from(`
        <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
            <rect x="4" y="4" width="${width - 8}" height="${height - 8}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="4"/>
            <text x="14" y="34" font-size="24" font-family="Arial" font-weight="700" fill="${color}">${label}</text>
            <text x="${width / 2}" y="${height / 2 + 10}" text-anchor="middle" font-size="${card.back ? 24 : 38}" font-family="Arial" font-weight="800" fill="${card.back ? '#f8fafc' : color}">${center}</text>
            <text x="${width - 14}" y="${height - 16}" text-anchor="end" font-size="24" font-family="Arial" font-weight="700" fill="${color}">${label}</text>
        </svg>
    `)
}

const cardAssetPath = (card) => path.join(CARD_DIR, card.back ? 'BACK.png' : `${card.rank}${card.suit}.png`)

const cardImage = async (card, width = 120, height = 168) => {
    const asset = cardAssetPath(card)
    try {
        if (fs.existsSync(asset)) {
            return sharp(asset).resize(width, height, { fit: 'fill' }).png().toBuffer()
        }
    } catch (err) {
        log('error', 'Failed to load card asset, using fallback', { asset, error: err.message })
    }

    return sharp(renderCardSvg(card, width, height)).png().toBuffer()
}

const tableImage = async (table) => {
    const shown = visibleCommunity(table)
    const cards = [...shown, ...Array.from({ length: 5 - shown.length }, () => ({ back: true }))]
    const width = 860
    const height = 260
    const cardWidth = 120
    const cardHeight = 168
    const gap = 22
    const startX = Math.floor((width - (cardWidth * 5 + gap * 4)) / 2)
    const composites = []

    for (let i = 0; i < cards.length; i += 1) {
        composites.push({
            input: await cardImage(cards[i], cardWidth, cardHeight),
            left: startX + i * (cardWidth + gap),
            top: 58
        })
    }

    const svg = Buffer.from(`
        <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
            <rect width="100%" height="100%" rx="28" fill="#0f5132"/>
            <ellipse cx="${width / 2}" cy="${height / 2}" rx="400" ry="108" fill="#145a3a" stroke="#c49a42" stroke-width="8"/>
            <text x="34" y="42" font-size="24" font-family="Arial" fill="#f8fafc" font-weight="700">Pot: ${table.pot} credits</text>
            <text x="${width - 34}" y="42" text-anchor="end" font-size="24" font-family="Arial" fill="#f8fafc" font-weight="700">${PHASE_LABEL[table.phase]}</text>
        </svg>
    `)
    const out = path.join(RENDER_DIR, `${table.id}-${Date.now()}.png`)
    await sharp(svg).composite(composites).png().toFile(out)
    return out
}

const handImage = async (cards, title = 'Your Hand') => {
    const width = 360
    const height = 230
    const composites = []
    for (let i = 0; i < cards.length; i += 1) {
        composites.push({ input: await cardImage(cards[i], 120, 168), left: 48 + i * 144, top: 46 })
    }
    const svg = Buffer.from(`
        <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
            <rect width="100%" height="100%" rx="18" fill="#111827"/>
            <text x="24" y="30" font-size="22" font-family="Arial" fill="#f8fafc" font-weight="700">${escapeXml(title)}</text>
        </svg>
    `)
    const out = path.join(RENDER_DIR, `hand-${Date.now()}-${crypto.randomUUID()}.png`)
    await sharp(svg).composite(composites).png().toFile(out)
    return out
}

const showdownImage = async (table, evaluated) => {
    const active = evaluated
    const width = 900
    const rowHeight = 210
    const height = 48 + active.length * rowHeight
    const composites = []
    const textRows = []

    for (let i = 0; i < active.length; i += 1) {
        const item = active[i]
        const top = 54 + i * rowHeight
        composites.push({ input: await cardImage(item.player.cards[0], 96, 134), left: 36, top })
        composites.push({ input: await cardImage(item.player.cards[1], 96, 134), left: 146, top })
        textRows.push(`
            <text x="270" y="${top + 38}" font-size="27" font-family="Arial" fill="#f8fafc" font-weight="700">${escapeXml(item.player.name)}</text>
            <text x="270" y="${top + 78}" font-size="23" font-family="Arial" fill="#d1d5db">Best Hand: ${escapeXml(item.hand.name)}</text>
            <text x="270" y="${top + 116}" font-size="23" font-family="Arial" fill="#fde68a">${item.won > 0 ? `Won ${item.won} credits` : 'No pot won'}</text>
        `)
    }

    const svg = Buffer.from(`
        <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
            <rect width="100%" height="100%" rx="22" fill="#111827"/>
            <text x="34" y="36" font-size="26" font-family="Arial" fill="#f8fafc" font-weight="800">Showdown</text>
            ${textRows.join('')}
        </svg>
    `)
    const out = path.join(RENDER_DIR, `showdown-${table.id}-${Date.now()}.png`)
    await sharp(svg).composite(composites).png().toFile(out)
    return out
}

const escapeXml = (value) => String(value).replace(/[<>&'"]/g, char => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;'
}[char]))

const freshDeck = () => {
    const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']
    const suits = ['S', 'H', 'D', 'C']
    const deck = ranks.flatMap(rank => suits.map(suit => ({ rank, suit })))
    for (let i = deck.length - 1; i > 0; i -= 1) {
        const j = crypto.randomInt(i + 1)
        ;[deck[i], deck[j]] = [deck[j], deck[i]]
    }
    return deck
}

const getPlayerByDiscord = async (discordId) => {
    const res = await axios.get(`${API}/player/by-discord/${discordId}`)
    return res.data
}

const applyCreditChanges = async (changes, reason) => {
    await axios.post(`${API}/player/poker-credits`, { changes, reason })
}

const joinedField = (table) => table.players.length
    ? table.players.map(player => `${player.seat + 1}. ${player.name}`).join('\n')
    : 'No players yet'

const lobbyEmbed = (table) => new EmbedBuilder()
    .setTitle('Texas Holdem Poker Table')
    .setColor(0x0f8f61)
    .addFields(
        { name: 'Host', value: `<@${table.hostId}>`, inline: true },
        { name: 'Buy-in', value: `${table.buyIn} credits`, inline: true },
        { name: 'Players Joined', value: `${table.players.length}/${table.maxPlayers}`, inline: true },
        { name: 'Max Players', value: `${table.maxPlayers}`, inline: true },
        { name: 'Table Status', value: PHASE_LABEL[table.phase], inline: true },
        { name: 'Players', value: joinedField(table) }
    )

const lobbyComponents = (table) => [
    new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`poker:${table.id}:join`).setLabel('Join Table').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`poker:${table.id}:leave`).setLabel('Leave Table').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`poker:${table.id}:start`).setLabel('Start Game').setStyle(ButtonStyle.Primary)
    )
]

const gameComponents = (table) => [
    new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`poker:${table.id}:show`).setLabel('Show Hand').setEmoji('🃏').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`poker:${table.id}:check`).setLabel('Check').setEmoji('✅').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`poker:${table.id}:call`).setLabel('Call').setEmoji('📞').setStyle(ButtonStyle.Primary)
    ),
    new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`poker:${table.id}:raise`).setLabel('Raise').setEmoji('⬆️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`poker:${table.id}:fold`).setLabel('Fold').setEmoji('❌').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`poker:${table.id}:allin`).setLabel('All In').setEmoji('🔥').setStyle(ButtonStyle.Danger)
    )
]

const endedComponents = (table) => [
    new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`poker:${table.id}:ended`).setLabel('Table Closed').setStyle(ButtonStyle.Secondary).setDisabled(true)
    )
]

const activePlayers = (table) => table.players.filter(player => !player.folded)
const bettingPlayers = (table) => table.players.filter(player => !player.folded && !player.allIn && player.stack > 0)
const visibleCommunity = (table) => {
    if (table.phase === 'flop') return table.community.slice(0, 3)
    if (table.phase === 'turn') return table.community.slice(0, 4)
    if (table.phase === 'river' || table.phase === 'showdown' || table.phase === 'ended') return table.community.slice(0, 5)
    return []
}

const currentPlayer = (table) => table.players[table.currentTurn]

const gameEmbed = (table) => {
    const current = currentPlayer(table)
    const remaining = activePlayers(table).map(player => `<@${player.id}>${player.allIn ? ' (all in)' : ''}`).join('\n') || 'None'
    const folded = table.players.filter(player => player.folded).map(player => `<@${player.id}>`).join('\n') || 'None'
    const callAmount = current ? Math.max(0, table.currentBet - current.currentBet) : 0

    return new EmbedBuilder()
        .setTitle('Texas Holdem Poker')
        .setColor(0x0f8f61)
        .addFields(
            { name: 'Pot', value: `${table.pot} credits`, inline: true },
            { name: 'Current Phase', value: PHASE_LABEL[table.phase], inline: true },
            { name: 'Current Turn', value: current ? `<@${current.id}>` : 'Resolving...', inline: true },
            { name: 'Community Cards', value: visibleCommunity(table).map(cardText).join(' ') || '[BACK] [BACK] [BACK] [BACK] [BACK]' },
            { name: 'Current Bet', value: `${table.currentBet} credits`, inline: true },
            { name: 'To Call', value: `${callAmount} credits`, inline: true },
            { name: 'Remaining Players', value: remaining, inline: true },
            { name: 'Folded Players', value: folded, inline: true }
        )
}

const cardText = (card) => `[${card.rank}${SUIT_SYMBOL[card.suit]}]`

const updateLobbyMessage = async (table, interaction = null) => {
    saveTable(table)
    const payload = { embeds: [lobbyEmbed(table)], components: lobbyComponents(table) }
    if (interaction) return interaction.update(payload)
    const channel = await table.client.channels.fetch(table.channelId)
    const message = await channel.messages.fetch(table.messageId)
    return message.edit(payload)
}

const updateGameMessage = async (table, announcement = null) => {
    saveTable(table)
    const image = await tableImage(table)
    const file = new AttachmentBuilder(image, { name: 'table.png' })
    const embed = gameEmbed(table).setImage('attachment://table.png')
    if (announcement) embed.setDescription(announcement)

    const channel = await table.client.channels.fetch(table.channelId)
    const message = await channel.messages.fetch(table.messageId)
    await message.edit({ embeds: [embed], components: gameComponents(table), files: [file] })
}

const clearTurnTimer = (table) => {
    if (table.timer) clearTimeout(table.timer)
    table.timer = null
}

const armTurnTimer = (table) => {
    clearTurnTimer(table)
    if (!PHASES.includes(table.phase) || !currentPlayer(table)) return

    table.timer = setTimeout(async () => {
        try {
            const player = currentPlayer(table)
            if (!player) return
            const toCall = Math.max(0, table.currentBet - player.currentBet)
            if (toCall === 0) {
                player.acted = true
                await proceedAfterAction(table, `${player.name} timed out and checked.`)
            } else {
                player.folded = true
                player.acted = true
                await proceedAfterAction(table, `${player.name} timed out and folded.`)
            }
        } catch (err) {
            log('error', 'Turn timer failed', { tableId: table.id, error: err.message })
        }
    }, CONFIG.turnSeconds * 1000)
}

const createTable = (message, buyIn) => ({
    id: crypto.randomUUID(),
    hostId: message.author.id,
    channelId: message.channel.id,
    messageId: null,
    guildId: message.guild?.id || null,
    phase: 'lobby',
    buyIn,
    maxPlayers: CONFIG.maxPlayers,
    minPlayers: CONFIG.minPlayers,
    smallBlind: Math.min(CONFIG.smallBlind, buyIn),
    bigBlind: Math.min(CONFIG.bigBlind, buyIn),
    pot: 0,
    currentBet: 0,
    dealerSeat: null,
    smallBlindSeat: null,
    bigBlindSeat: null,
    currentTurn: 0,
    lastRaise: CONFIG.bigBlind,
    deck: [],
    community: [],
    players: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    client: message.client,
    timer: null
})

export const handlePokerMessage = async (message) => {
    if (message.author.bot || !message.content.toLowerCase().startsWith(`${CONFIG.prefix}poker`)) return false

    const args = message.content.trim().split(/\s+/)
    const subcommand = args[1]?.toLowerCase()
    if (subcommand !== 'create') {
        await message.reply('Use `?poker create` to create a poker table.')
        return true
    }

    if (tables.has(message.channel.id)) {
        await message.reply('A poker table is already active in this channel.')
        return true
    }

    const buyIn = Number.parseInt(args[2] || CONFIG.buyIn, 10)
    if (!Number.isInteger(buyIn) || buyIn <= 0) {
        await message.reply('Buy-in must be a positive whole number of credits.')
        return true
    }

    const host = await getPlayerByDiscord(message.author.id)
    if (!host) {
        await message.reply('You need to register before creating a poker table.')
        return true
    }
    if (host.credits < buyIn) {
        await message.reply(`You need ${buyIn} credits to host this table. Your current balance is ${host.credits}.`)
        return true
    }

    const table = createTable(message, buyIn)
    table.players.push(newTablePlayer(message.author, host, 0, buyIn))
    const tableMessage = await message.channel.send({ embeds: [lobbyEmbed(table)], components: lobbyComponents(table) })
    table.messageId = tableMessage.id
    tables.set(table.channelId, table)
    saveTable(table)
    return true
}

const newTablePlayer = (discordUser, playerRecord, seat, buyIn) => ({
    id: discordUser.id,
    name: playerRecord?.name || publicName(discordUser),
    seat,
    stack: buyIn,
    buyIn,
    totalCommitted: 0,
    currentBet: 0,
    cards: [],
    folded: false,
    allIn: false,
    acted: false,
    registeredPlayerId: playerRecord?.id || null
})

export const handlePokerInteraction = async (interaction) => {
    if (!interaction.isButton() && !interaction.isModalSubmit()) return false

    const parts = interaction.customId.split(':')
    if (parts[0] !== 'poker') return false

    const [, tableId, action] = parts
    const table = [...tables.values()].find(item => item.id === tableId)
    if (!table) {
        await interaction.reply({ content: 'This poker table is no longer active.', ephemeral: true })
        return true
    }
    table.client = interaction.client

    try {
        if (interaction.isModalSubmit()) {
            await handleRaiseSubmit(interaction, table)
            return true
        }

        if (action === 'join') await joinTable(interaction, table)
        else if (action === 'leave') await leaveTable(interaction, table)
        else if (action === 'start') await startGame(interaction, table)
        else if (action === 'show') await showHand(interaction, table)
        else if (['check', 'call', 'raise', 'fold', 'allin'].includes(action)) await bettingAction(interaction, table, action)
        else await interaction.reply({ content: 'That poker action is no longer available.', ephemeral: true })
    } catch (err) {
        log('error', 'Poker interaction failed', { tableId: table.id, action, error: err.message })
        const payload = { content: 'Poker action failed. Please try again.', ephemeral: true }
        if (interaction.deferred || interaction.replied) await interaction.followUp(payload)
        else await interaction.reply(payload)
    }

    return true
}

const joinTable = async (interaction, table) => {
    if (table.phase !== 'lobby') return interaction.reply({ content: 'This table has already started.', ephemeral: true })
    if (table.players.some(player => player.id === interaction.user.id)) return interaction.reply({ content: 'You are already seated at this table.', ephemeral: true })
    if (table.players.length >= table.maxPlayers) return interaction.reply({ content: 'This table is full.', ephemeral: true })

    const playerRecord = await getPlayerByDiscord(interaction.user.id)
    if (!playerRecord) return interaction.reply({ content: 'You need to register before joining poker.', ephemeral: true })
    if (playerRecord.credits < table.buyIn) {
        return interaction.reply({ content: `You need ${table.buyIn} credits to join. Your current balance is ${playerRecord.credits}.`, ephemeral: true })
    }

    table.players.push(newTablePlayer(interaction.user, playerRecord, table.players.length, table.buyIn))
    await updateLobbyMessage(table, interaction)
}

const leaveTable = async (interaction, table) => {
    const index = table.players.findIndex(player => player.id === interaction.user.id)
    if (index === -1) return interaction.reply({ content: 'You are not seated at this table.', ephemeral: true })
    if (table.phase !== 'lobby') return interaction.reply({ content: 'You cannot leave after the hand has started. Fold on your turn instead.', ephemeral: true })

    table.players.splice(index, 1)
    table.players.forEach((player, seat) => { player.seat = seat })

    if (!table.players.length) {
        await interaction.update({ embeds: [lobbyEmbed(table).setDescription('Table closed because all players left.')], components: endedComponents(table) })
        deleteTable(table)
        return
    }

    if (interaction.user.id === table.hostId) table.hostId = table.players[0].id
    await updateLobbyMessage(table, interaction)
}

const startGame = async (interaction, table) => {
    if (interaction.user.id !== table.hostId) return interaction.reply({ content: 'Only the host may start this table.', ephemeral: true })
    if (table.players.length < table.minPlayers) return interaction.reply({ content: 'At least 2 players are required.', ephemeral: true })
    if (table.phase !== 'lobby') return interaction.reply({ content: 'This game has already started.', ephemeral: true })

    const records = await Promise.all(table.players.map(player => getPlayerByDiscord(player.id)))
    const missing = table.players.find((player, index) => !records[index])
    if (missing) return interaction.reply({ content: `${missing.name} is not registered anymore.`, ephemeral: true })
    const short = table.players.find((player, index) => records[index].credits < table.buyIn)
    if (short) return interaction.reply({ content: `${short.name} does not have enough credits for the buy-in.`, ephemeral: true })

    await applyCreditChanges(table.players.map(player => ({ discordId: player.id, amount: -table.buyIn })), `Poker buy-in ${table.id}`)

    table.phase = 'preflop'
    table.deck = freshDeck()
    table.community = [table.deck.pop(), table.deck.pop(), table.deck.pop(), table.deck.pop(), table.deck.pop()]
    table.pot = 0
    table.currentBet = 0
    table.lastRaise = table.bigBlind
    table.dealerSeat = crypto.randomInt(table.players.length)
    table.smallBlindSeat = table.players.length === 2 ? table.dealerSeat : nextSeat(table, table.dealerSeat)
    table.bigBlindSeat = nextSeat(table, table.smallBlindSeat)

    for (const player of table.players) {
        Object.assign(player, {
            stack: table.buyIn,
            totalCommitted: 0,
            currentBet: 0,
            cards: [table.deck.pop(), table.deck.pop()],
            folded: false,
            allIn: false,
            acted: false
        })
    }

    postBlind(table, table.smallBlindSeat, table.smallBlind)
    postBlind(table, table.bigBlindSeat, table.bigBlind)
    table.currentBet = table.players[table.bigBlindSeat].currentBet
    table.currentTurn = nextSeat(table, table.bigBlindSeat)
    await interaction.deferUpdate()
    await updateGameMessage(table, `Blinds posted. Small blind: <@${table.players[table.smallBlindSeat].id}>. Big blind: <@${table.players[table.bigBlindSeat].id}>.`)
    armTurnTimer(table)
}

const nextSeat = (table, fromSeat) => {
    for (let offset = 1; offset <= table.players.length; offset += 1) {
        const index = (fromSeat + offset) % table.players.length
        const player = table.players[index]
        if (!player.folded && !player.allIn && player.stack > 0) return index
    }
    return fromSeat
}

const postBlind = (table, seat, amount) => {
    const player = table.players[seat]
    const paid = Math.min(player.stack, amount)
    player.stack -= paid
    player.currentBet += paid
    player.totalCommitted += paid
    player.allIn = player.stack === 0
    table.pot += paid
}

const showHand = async (interaction, table) => {
    const player = table.players.find(item => item.id === interaction.user.id)
    if (!player || !player.cards.length) return interaction.reply({ content: 'You do not have a hand at this table.', ephemeral: true })

    const image = await handImage(player.cards)
    const file = new AttachmentBuilder(image, { name: 'hand.png' })
    const embed = new EmbedBuilder()
        .setTitle('Your Hand')
        .setColor(0x111827)
        .setDescription(`${player.cards.map(cardText).join(' ')}\n\nPot: ${table.pot}\nPhase: ${PHASE_LABEL[table.phase]}\nYour remaining credits at table: ${player.stack}`)
        .setImage('attachment://hand.png')
    await interaction.reply({ embeds: [embed], files: [file], ephemeral: true })
}

const bettingAction = async (interaction, table, action) => {
    if (!PHASES.includes(table.phase)) return interaction.reply({ content: 'Betting is not active on this table.', ephemeral: true })
    const player = currentPlayer(table)
    if (!player || player.id !== interaction.user.id) return interaction.reply({ content: 'It is not your turn.', ephemeral: true })

    if (action === 'raise') {
        const modal = new ModalBuilder()
            .setCustomId(`poker:${table.id}:raiseSubmit`)
            .setTitle('Raise Amount')
            .addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('amount')
                    .setLabel('Amount')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setPlaceholder(`${minimumRaiseTo(table, player)} or more`)
            ))
        await interaction.showModal(modal)
        return
    }

    const message = performAction(table, player, action)
    await interaction.reply({ content: message.private, ephemeral: true })
    if (!message.valid) return
    await proceedAfterAction(table, message.public)
}

const handleRaiseSubmit = async (interaction, table) => {
    const player = currentPlayer(table)
    if (!player || player.id !== interaction.user.id) return interaction.reply({ content: 'It is not your turn.', ephemeral: true })

    const amount = Number.parseInt(interaction.fields.getTextInputValue('amount'), 10)
    if (!Number.isInteger(amount) || amount < 0) return interaction.reply({ content: 'Raise amount must be a valid positive integer.', ephemeral: true })

    const minTotal = minimumRaiseTo(table, player)
    if (amount < minTotal) return interaction.reply({ content: `Minimum raise is ${minTotal} total credits for this betting round.`, ephemeral: true })
    if (amount > player.currentBet + player.stack) return interaction.reply({ content: `You cannot exceed your table balance of ${player.currentBet + player.stack} credits.`, ephemeral: true })

    const previousBet = table.currentBet
    commitToBet(table, player, amount)
    table.lastRaise = amount - previousBet
    table.currentBet = amount
    resetActionFlagsAfterRaise(table, player)
    player.acted = true

    await interaction.reply({ content: `Raised to ${amount} credits.`, ephemeral: true })
    await proceedAfterAction(table, `${player.name} raised to ${amount} credits.`)
}

const minimumRaiseTo = (table, player) => {
    if (table.currentBet === 0) return Math.min(table.bigBlind, player.currentBet + player.stack)
    return Math.min(table.currentBet + table.lastRaise, player.currentBet + player.stack)
}

const performAction = (table, player, action) => {
    const toCall = Math.max(0, table.currentBet - player.currentBet)

    if (action === 'check') {
        if (toCall > 0) return { private: `You need to call ${toCall} credits or fold.`, public: null, valid: false }
        player.acted = true
        return { private: 'Checked.', public: `${player.name} checked.`, valid: true }
    }

    if (action === 'call') {
        if (toCall === 0) {
            player.acted = true
            return { private: 'No bet to call, so you checked.', public: `${player.name} checked.`, valid: true }
        }
        const paid = commitChips(table, player, toCall)
        player.acted = true
        return { private: `Called ${paid} credits.`, public: `${player.name} called${player.allIn ? ' all in' : ''}.`, valid: true }
    }

    if (action === 'fold') {
        player.folded = true
        player.acted = true
        return { private: 'Folded.', public: `${player.name} folded.`, valid: true }
    }

    if (action === 'allin') {
        const target = player.currentBet + player.stack
        const previousBet = table.currentBet
        commitToBet(table, player, target)
        if (target > previousBet) {
            table.currentBet = target
            if (target - previousBet >= table.lastRaise) {
                table.lastRaise = target - previousBet
                resetActionFlagsAfterRaise(table, player)
            }
        }
        player.acted = true
        return { private: `All in for ${target} total credits.`, public: `${player.name} is all in.`, valid: true }
    }

    return { private: 'Unknown action.', public: null, valid: false }
}

const commitChips = (table, player, amount) => {
    const paid = Math.min(player.stack, amount)
    player.stack -= paid
    player.currentBet += paid
    player.totalCommitted += paid
    player.allIn = player.stack === 0
    table.pot += paid
    return paid
}

const commitToBet = (table, player, targetBet) => commitChips(table, player, Math.max(0, targetBet - player.currentBet))

const resetActionFlagsAfterRaise = (table, raiser) => {
    for (const player of table.players) {
        if (!player.folded && !player.allIn && player.id !== raiser.id) player.acted = false
    }
}

const bettingRoundComplete = (table) => bettingPlayers(table).every(player => player.acted && player.currentBet === table.currentBet)

const proceedAfterAction = async (table, announcement = null) => {
    clearTurnTimer(table)
    if (activePlayers(table).length === 1) {
        await awardUncontested(table, announcement)
        return
    }

    if (bettingPlayers(table).length === 0 || bettingRoundComplete(table)) {
        await advancePhase(table, announcement)
        return
    }

    table.currentTurn = nextSeat(table, table.currentTurn)
    await updateGameMessage(table, announcement)
    armTurnTimer(table)
}

const advancePhase = async (table, announcement) => {
    for (const player of table.players) {
        player.currentBet = 0
        player.acted = false
    }
    table.currentBet = 0
    table.lastRaise = table.bigBlind

    if (table.phase === 'preflop') table.phase = 'flop'
    else if (table.phase === 'flop') table.phase = 'turn'
    else if (table.phase === 'turn') table.phase = 'river'
    else if (table.phase === 'river') {
        await showdown(table, announcement)
        return
    }

    table.currentTurn = nextSeat(table, table.dealerSeat)
    if (bettingPlayers(table).length === 0) {
        await advancePhase(table, announcement)
        return
    }

    await updateGameMessage(table, announcement ? `${announcement}\n${PHASE_LABEL[table.phase]} begins.` : `${PHASE_LABEL[table.phase]} begins.`)
    armTurnTimer(table)
}

const buildSidePots = (table) => {
    const contributors = table.players
        .filter(player => player.totalCommitted > 0)
        .map(player => ({ player, amount: player.totalCommitted }))
        .sort((a, b) => a.amount - b.amount)
    const pots = []
    let previous = 0

    for (const contributor of contributors) {
        const level = contributor.amount
        if (level <= previous) continue
        const eligibleContributors = contributors.filter(item => item.amount >= level)
        const amount = (level - previous) * eligibleContributors.length
        const eligible = eligibleContributors.map(item => item.player).filter(player => !player.folded)
        if (amount > 0 && eligible.length) pots.push({ amount, eligible })
        previous = level
    }

    return pots
}

const showdown = async (table, announcement = null) => {
    clearTurnTimer(table)
    table.phase = 'showdown'
    const evaluated = activePlayers(table).map(player => ({
        player,
        hand: evaluateTexasHoldem([...player.cards, ...table.community])
    }))
    const winnings = new Map(table.players.map(player => [player.id, 0]))

    for (const pot of buildSidePots(table)) {
        const contenders = evaluated.filter(item => pot.eligible.some(player => player.id === item.player.id))
        contenders.sort((a, b) => compareHands(b.hand, a.hand))
        const best = contenders[0].hand
        const winners = contenders.filter(item => compareHands(item.hand, best) === 0)
        const share = Math.floor(pot.amount / winners.length)
        let remainder = pot.amount % winners.length
        for (const winner of winners) {
            const bonus = share + (remainder > 0 ? 1 : 0)
            remainder -= remainder > 0 ? 1 : 0
            winnings.set(winner.player.id, winnings.get(winner.player.id) + bonus)
        }
    }

    for (const item of evaluated) item.won = winnings.get(item.player.id) || 0
    const creditChanges = [...winnings.entries()]
        .filter(([, amount]) => amount > 0)
        .map(([discordId, amount]) => ({ discordId, amount }))
    if (creditChanges.length) await applyCreditChanges(creditChanges, `Poker payout ${table.id}`)

    const bestOverall = [...evaluated].sort((a, b) => compareHands(b.hand, a.hand))[0]
    const winners = evaluated.filter(item => (winnings.get(item.player.id) || 0) > 0)
    const image = await showdownImage(table, evaluated)
    const file = new AttachmentBuilder(image, { name: 'showdown.png' })
    const embed = new EmbedBuilder()
        .setTitle('Poker Showdown')
        .setColor(0xd4af37)
        .setDescription([
            announcement,
            `Winning hand: ${bestOverall.hand.name}`,
            `Winner${winners.length === 1 ? '' : 's'}: ${winners.map(item => `<@${item.player.id}> (${item.won})`).join(', ')}`
        ].filter(Boolean).join('\n'))
        .setImage('attachment://showdown.png')

    const channel = await table.client.channels.fetch(table.channelId)
    const message = await channel.messages.fetch(table.messageId)
    await message.edit({ embeds: [embed], components: endedComponents(table), files: [file] })
    table.phase = 'ended'
    saveTable(table)
    deleteTable(table)
}

const awardUncontested = async (table, announcement = null) => {
    clearTurnTimer(table)
    const winner = activePlayers(table)[0]
    if (winner && table.pot > 0) await applyCreditChanges([{ discordId: winner.id, amount: table.pot }], `Poker uncontested payout ${table.id}`)

    const embed = new EmbedBuilder()
        .setTitle('Poker Hand Complete')
        .setColor(0xd4af37)
        .setDescription([announcement, `<@${winner.id}> wins ${table.pot} credits. Table closed.`].filter(Boolean).join('\n'))
    const channel = await table.client.channels.fetch(table.channelId)
    const message = await channel.messages.fetch(table.messageId)
    await message.edit({ embeds: [embed], components: endedComponents(table), files: [] })
    table.phase = 'ended'
    saveTable(table)
    deleteTable(table)
}

export const initPoker = async (client) => {
    ensureStorage()
    restoreTables()
    for (const table of tables.values()) {
        table.client = client
        if (PHASES.includes(table.phase)) armTurnTimer(table)
    }
    client.on('guildMemberRemove', member => {
        handleMemberRemoved(member).catch(err => log('error', 'Failed to handle member leave', { error: err.message }))
    })
    log('info', 'Poker system initialized', { tables: tables.size })
}

const handleMemberRemoved = async (member) => {
    for (const table of tables.values()) {
        if (table.guildId !== member.guild.id) continue

        const player = table.players.find(item => item.id === member.id)
        if (!player) continue

        table.client = member.client
        if (table.phase === 'lobby') {
            table.players = table.players.filter(item => item.id !== member.id)
            table.players.forEach((item, seat) => { item.seat = seat })
            if (!table.players.length) {
                deleteTable(table)
                continue
            }
            if (table.hostId === member.id) table.hostId = table.players[0].id
            await updateLobbyMessage(table)
            continue
        }

        if (PHASES.includes(table.phase) && !player.folded) {
            player.folded = true
            player.acted = true
            await proceedAfterAction(table, `${player.name} left the server and folded.`)
        }
    }
}
