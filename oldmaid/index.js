import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import axios from 'axios'
import Database from 'better-sqlite3'
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} from 'discord.js'

const API = process.env.API_BASE_URL
const BOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = path.join(BOT_DIR, 'data', 'oldmaid')
const DB_PATH = path.join(DATA_DIR, 'oldmaid.sqlite')

const CONFIG = {
    prefix: '?',
    maxPlayers: Number(process.env.OLDMAID_MAX_PLAYERS || 6),
    minPlayers: 2,
    turnSeconds: Number(process.env.OLDMAID_TURN_SECONDS || 60),
    minBet: Number(process.env.OLDMAID_MIN_BET || 10)
}

const SUITS = [
    { name: 'Sword', pokemon: 'Chien-Pao' },
    { name: 'Beads', pokemon: 'Chi-Yu' },
    { name: 'Tablets', pokemon: 'Wo-Chien' },
    { name: 'Vessel', pokemon: 'Ting-Lu' }
]
const RANKS = ['Ace', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'Ruin', 'Shrine', 'Awakening']
const PHASE_LABEL = {
    lobby: 'Gathering at the Ruins',
    betting: 'Wagering at the Ruins',
    drawing: 'Relic Drawing',
    ended: 'Ruins Sealed'
}

const tables = new Map()
let db

const log = (level, message, meta = {}) => {
    console[level === 'error' ? 'error' : 'log'](JSON.stringify({
        scope: 'oldmaid',
        level,
        message,
        ...meta,
        time: new Date().toISOString()
    }))
}

const ensureStorage = () => {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    db = new Database(DB_PATH)
    db.pragma('journal_mode = WAL')
    db.exec(`
        CREATE TABLE IF NOT EXISTS oldmaid_games (
            game_id TEXT PRIMARY KEY,
            channel_id TEXT NOT NULL,
            message_id TEXT,
            phase TEXT NOT NULL,
            pot INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            state_json TEXT NOT NULL
        );
    `)
}

const saveTable = (table) => {
    table.updatedAt = new Date().toISOString()
    db.prepare(`
        INSERT INTO oldmaid_games (game_id, channel_id, message_id, phase, pot, created_at, updated_at, state_json)
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
}

const deleteTable = (table) => {
    clearTimer(table)
    db.prepare('DELETE FROM oldmaid_games WHERE game_id = ?').run(table.id)
    tables.delete(table.channelId)
}

const stripRuntime = (table) => {
    const { timer, client, ...safe } = table
    return safe
}

const restoreTables = () => {
    for (const row of db.prepare('SELECT state_json FROM oldmaid_games WHERE phase != ?').all('ended')) {
        try {
            const table = JSON.parse(row.state_json)
            table.timer = null
            tables.set(table.channelId, table)
        } catch (err) {
            log('error', 'Failed to restore Old Maid table', { error: err.message })
        }
    }
}

const publicName = (user) => user.globalName || user.username || user.displayName || user.id
const cardText = (card) => `${card.suit} ${card.rank}`
const activePlayers = (table) => table.players.filter(player => !player.folded)
const drawingPlayers = (table) => activePlayers(table).filter(player => player.hand.length > 0)
const currentPlayer = (table) => table.players[table.currentTurn]

const getPlayerByDiscord = async (discordId) => {
    const res = await axios.get(`${API}/player/by-discord/${discordId}`)
    return res.data
}

const applyCreditChanges = async (changes, reason) => {
    await axios.post(`${API}/player/poker-credits`, { changes, reason })
}

const shuffle = (items) => {
    for (let i = items.length - 1; i > 0; i -= 1) {
        const j = crypto.randomInt(i + 1)
        ;[items[i], items[j]] = [items[j], items[i]]
    }
    return items
}

const freshDeck = () => {
    const deck = RANKS.flatMap(rank => SUITS.map(suit => ({ id: crypto.randomUUID(), rank, suit: suit.name, pokemon: suit.pokemon })))
    const removed = deck.splice(crypto.randomInt(deck.length), 1)[0]
    return { deck: shuffle(deck), removedRank: removed.rank }
}

const removePairs = (player) => {
    let pairs = 0
    const kept = []
    const byRank = new Map()
    for (const card of player.hand) {
        if (!byRank.has(card.rank)) byRank.set(card.rank, [])
        byRank.get(card.rank).push(card)
    }

    for (const cards of byRank.values()) {
        pairs += Math.floor(cards.length / 2)
        if (cards.length % 2 === 1) kept.push(cards[cards.length - 1])
    }

    player.hand = shuffle(kept)
    player.pairsMade += pairs
    return pairs
}

const nextActiveSeat = (table, fromSeat, requireCards = false) => {
    for (let offset = 1; offset <= table.players.length; offset += 1) {
        const index = (fromSeat + offset) % table.players.length
        const player = table.players[index]
        if (!player.folded && (!requireCards || player.hand.length > 0)) return index
    }
    return fromSeat
}

const previousActiveSeat = (table, fromSeat) => {
    for (let offset = 1; offset <= table.players.length; offset += 1) {
        const index = (fromSeat - offset + table.players.length) % table.players.length
        const player = table.players[index]
        if (!player.folded) return index
    }
    return fromSeat
}

const nextDrawableTargetSeat = (table, fromSeat) => nextActiveSeat(table, fromSeat, true)

const joinedField = (table) => table.players.length
    ? table.players.map(player => `${player.seat + 1}. ${player.name}`).join('\n')
    : 'No players yet'

const lobbyEmbed = (table) => new EmbedBuilder()
    .setTitle('Old Maid at the Ruins')
    .setColor(0x7c3aed)
    .addFields(
        { name: 'Host', value: `<@${table.hostId}>`, inline: true },
        { name: 'Players Joined', value: `${table.players.length}/${table.maxPlayers}`, inline: true },
        { name: 'Table Status', value: PHASE_LABEL[table.phase], inline: true },
        { name: 'Players', value: joinedField(table) }
    )

const lobbyComponents = (table) => [
    new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`oldmaid:${table.id}:join`).setLabel('Join Table').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`oldmaid:${table.id}:leave`).setLabel('Leave Table').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`oldmaid:${table.id}:start`).setLabel('Start Game').setStyle(ButtonStyle.Primary)
    )
]

const gameComponents = (table) => {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`oldmaid:${table.id}:show`).setLabel('Show Hand').setStyle(ButtonStyle.Secondary)
    )

    if (table.phase === 'betting') {
        const canCheck = table.betting.currentBet === 0
        row.addComponents(
            new ButtonBuilder().setCustomId(`oldmaid:${table.id}:bet`).setLabel(canCheck ? 'Bet' : 'Call').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`oldmaid:${table.id}:raise`).setLabel('Raise').setStyle(ButtonStyle.Primary).setDisabled(table.betting.currentBet === 0),
            new ButtonBuilder().setCustomId(`oldmaid:${table.id}:check`).setLabel('Check').setStyle(ButtonStyle.Success).setDisabled(!canCheck || !table.betting.allowCheck),
            new ButtonBuilder().setCustomId(`oldmaid:${table.id}:fold`).setLabel('Fold').setStyle(ButtonStyle.Danger)
        )
        return [row]
    }

    if (table.phase === 'drawing') {
        row.addComponents(
            new ButtonBuilder().setCustomId(`oldmaid:${table.id}:draw`).setLabel('Draw Card').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`oldmaid:${table.id}:fold`).setLabel('Fold').setStyle(ButtonStyle.Danger)
        )
        return [row]
    }

    return [row]
}

const endedComponents = (table) => [
    new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`oldmaid:${table.id}:ended`).setLabel('Table Closed').setStyle(ButtonStyle.Secondary).setDisabled(true)
    )
]

const gameEmbed = (table, announcement = null) => {
    const current = currentPlayer(table)
    const active = activePlayers(table).map(player => `<@${player.id}> (${player.hand.length} cards)`).join('\n') || 'None'
    const folded = table.players.filter(player => player.folded).map(player => `<@${player.id}>`).join('\n') || 'None'
    const target = table.phase === 'drawing' && current ? table.players[nextDrawableTargetSeat(table, table.currentTurn)] : null

    const embed = new EmbedBuilder()
        .setTitle('Old Maid at the Ruins')
        .setColor(0x7c3aed)
        .addFields(
            { name: 'Pot', value: `${table.pot} credits`, inline: true },
            { name: 'Phase', value: PHASE_LABEL[table.phase], inline: true },
            { name: 'Current Turn', value: current ? `<@${current.id}>` : 'Resolving...', inline: true },
            { name: 'Active Players', value: active, inline: true },
            { name: 'Folded Players', value: folded, inline: true },
            { name: 'Draw Target', value: target && target.id !== current?.id ? `<@${target.id}>` : 'None', inline: true }
        )

    if (table.phase === 'betting') {
        const toCall = current ? Math.max(0, table.betting.currentBet - current.currentBet) : 0
        embed.addFields(
            { name: 'Current Bet', value: `${table.betting.currentBet} credits`, inline: true },
            { name: 'To Call', value: `${toCall} credits`, inline: true }
        )
    }

    if (announcement) embed.setDescription(announcement)
    return embed
}

const createTable = (message) => ({
    id: crypto.randomUUID(),
    hostId: message.author.id,
    channelId: message.channel.id,
    messageId: null,
    guildId: message.guild?.id || null,
    phase: 'lobby',
    maxPlayers: CONFIG.maxPlayers,
    minPlayers: CONFIG.minPlayers,
    pot: 0,
    currentTurn: 0,
    turnOrder: [],
    drawTurnsSinceBet: 0,
    removedRank: null,
    betting: null,
    players: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    client: message.client,
    timer: null
})

const newTablePlayer = (discordUser, playerRecord, seat) => ({
    id: discordUser.id,
    name: playerRecord?.name || publicName(discordUser),
    seat,
    stack: playerRecord?.credits || 0,
    currentBet: 0,
    totalCommitted: 0,
    folded: false,
    acted: false,
    hand: [],
    pairsMade: 0,
    registeredPlayerId: playerRecord?.id || null
})

export const handleOldMaidMessage = async (message) => {
    if (message.author.bot || message.content.trim().toLowerCase() !== `${CONFIG.prefix}oldmaid`) return false

    if (tables.has(message.channel.id)) {
        await message.reply('An Old Maid table is already active in this channel.')
        return true
    }

    const host = await getPlayerByDiscord(message.author.id)
    if (!host) {
        await message.reply('You need to register before creating an Old Maid table.')
        return true
    }
    if (host.credits < CONFIG.minBet) {
        await message.reply(`You need at least ${CONFIG.minBet} credits to host Old Maid. Your current balance is ${host.credits}.`)
        return true
    }

    const table = createTable(message)
    table.players.push(newTablePlayer(message.author, host, 0))
    const tableMessage = await message.channel.send({ embeds: [lobbyEmbed(table)], components: lobbyComponents(table) })
    table.messageId = tableMessage.id
    tables.set(table.channelId, table)
    saveTable(table)
    return true
}

export const handleOldMaidInteraction = async (interaction) => {
    if (!interaction.isButton() && !interaction.isModalSubmit()) return false

    const parts = interaction.customId.split(':')
    if (parts[0] !== 'oldmaid') return false

    const [, tableId, action] = parts
    const table = [...tables.values()].find(item => item.id === tableId)
    if (!table) {
        await interaction.reply({ content: 'This Old Maid table is no longer active.', ephemeral: true })
        return true
    }
    table.client = interaction.client

    try {
        if (interaction.isModalSubmit()) await handleBetSubmit(interaction, table, action)
        else if (action === 'join') await joinTable(interaction, table)
        else if (action === 'leave') await leaveTable(interaction, table)
        else if (action === 'start') await startGame(interaction, table)
        else if (action === 'show') await showHand(interaction, table)
        else if (['bet', 'raise', 'check', 'fold', 'draw'].includes(action)) await gameAction(interaction, table, action)
        else await interaction.reply({ content: 'That Old Maid action is no longer available.', ephemeral: true })
    } catch (err) {
        log('error', 'Old Maid interaction failed', { tableId, action, error: err.message })
        const payload = { content: err.response?.data?.error || 'Old Maid action failed. Please try again.', ephemeral: true }
        if (interaction.deferred || interaction.replied) await interaction.followUp(payload)
        else await interaction.reply(payload)
    }

    return true
}

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
    const channel = await table.client.channels.fetch(table.channelId)
    const message = await channel.messages.fetch(table.messageId)
    await message.edit({ embeds: [gameEmbed(table, announcement)], components: gameComponents(table) })
}

const joinTable = async (interaction, table) => {
    if (table.phase !== 'lobby') return interaction.reply({ content: 'This table has already started.', ephemeral: true })
    if (table.players.some(player => player.id === interaction.user.id)) return interaction.reply({ content: 'You are already seated at this table.', ephemeral: true })
    if (table.players.length >= table.maxPlayers) return interaction.reply({ content: 'This table is full.', ephemeral: true })

    const playerRecord = await getPlayerByDiscord(interaction.user.id)
    if (!playerRecord) return interaction.reply({ content: 'You need to register before joining Old Maid.', ephemeral: true })
    if (playerRecord.credits < CONFIG.minBet) return interaction.reply({ content: `You need at least ${CONFIG.minBet} credits to join. Your current balance is ${playerRecord.credits}.`, ephemeral: true })

    table.players.push(newTablePlayer(interaction.user, playerRecord, table.players.length))
    await updateLobbyMessage(table, interaction)
}

const leaveTable = async (interaction, table) => {
    const index = table.players.findIndex(player => player.id === interaction.user.id)
    if (index === -1) return interaction.reply({ content: 'You are not seated at this table.', ephemeral: true })
    if (table.phase !== 'lobby') return interaction.reply({ content: 'You cannot leave after Old Maid has started. Fold on your turn instead.', ephemeral: true })

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
    const short = table.players.find((player, index) => records[index].credits < CONFIG.minBet)
    if (short) return interaction.reply({ content: `${short.name} needs at least ${CONFIG.minBet} credits to start.`, ephemeral: true })

    table.turnOrder = shuffle(table.players.map((_, index) => index))
    table.players.forEach((player, index) => {
        player.stack = records[index].credits
        player.currentBet = 0
        player.totalCommitted = 0
        player.folded = false
        player.acted = false
        player.hand = []
        player.pairsMade = 0
    })

    const { deck, removedRank } = freshDeck()
    table.removedRank = removedRank
    let dealIndex = 0
    while (deck.length) {
        table.players[table.turnOrder[dealIndex % table.turnOrder.length]].hand.push(deck.pop())
        dealIndex += 1
    }

    const pairAnnouncements = []
    for (const player of table.players) {
        const pairs = removePairs(player)
        if (pairs > 0) pairAnnouncements.push(`${player.name} put down ${pairs} pair${pairs === 1 ? '' : 's'}.`)
    }

    startBettingRound(table, table.turnOrder[0], { opening: true, allowOpeningCheck: false })
    await interaction.deferUpdate()
    await updateGameMessage(table, ['The Old Maid deck has been dealt.', ...pairAnnouncements, 'Opening wagers begin.'].join('\n'))
    armTimer(table)
}

const startBettingRound = (table, starterSeat, options = {}) => {
    clearTimer(table)
    for (const player of table.players) {
        player.currentBet = 0
        player.acted = false
    }
    table.phase = 'betting'
    table.currentTurn = starterSeat
    table.betting = {
        currentBet: 0,
        minRaise: CONFIG.minBet,
        allowCheck: options.allowOpeningCheck ?? true,
        opening: options.opening ?? false
    }
}

const showHand = async (interaction, table) => {
    const player = table.players.find(item => item.id === interaction.user.id)
    if (!player) return interaction.reply({ content: 'You are not seated at this table.', ephemeral: true })

    const hand = player.hand.length
        ? player.hand.map((card, index) => `${index + 1}. ${cardText(card)}`).join('\n')
        : 'You have no cards left.'
    await interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setTitle('Your Old Maid Hand')
                .setColor(0x7c3aed)
                .setDescription(hand)
                .addFields(
                    { name: 'Pot', value: `${table.pot} credits`, inline: true },
                    { name: 'Phase', value: PHASE_LABEL[table.phase], inline: true },
                    { name: 'Your Table Balance', value: `${player.stack} credits`, inline: true }
                )
        ],
        ephemeral: true
    })
}

const gameAction = async (interaction, table, action) => {
    const player = currentPlayer(table)
    if (!player || player.id !== interaction.user.id) return interaction.reply({ content: 'It is not your turn.', ephemeral: true })

    if (action === 'fold') {
        player.folded = true
        player.acted = true
        await interaction.reply({ content: 'Folded.', ephemeral: true })
        await proceedAfterFold(table, `${player.name} folded.`)
        return
    }

    if (table.phase === 'betting') {
        await bettingAction(interaction, table, player, action)
        return
    }

    if (table.phase === 'drawing' && action === 'draw') {
        await drawAction(interaction, table, player)
        return
    }

    await interaction.reply({ content: 'That action is not available right now.', ephemeral: true })
}

const bettingAction = async (interaction, table, player, action) => {
    const toCall = Math.max(0, table.betting.currentBet - player.currentBet)

    if (action === 'check') {
        if (!table.betting.allowCheck || table.betting.currentBet > 0) return interaction.reply({ content: 'You cannot check after a bet has been placed.', ephemeral: true })
        player.acted = true
        await interaction.reply({ content: 'Checked.', ephemeral: true })
        await proceedAfterBettingAction(table, `${player.name} checked.`)
        return
    }

    if (action === 'bet' && table.betting.currentBet > 0) {
        if (toCall <= 0) return interaction.reply({ content: 'There is no bet to call.', ephemeral: true })
        const paid = await commitCredits(table, player, toCall)
        player.acted = true
        await interaction.reply({ content: `Called ${paid} credits.`, ephemeral: true })
        await proceedAfterBettingAction(table, `${player.name} called.`)
        return
    }

    if (action === 'raise' && table.betting.currentBet === 0) {
        return interaction.reply({ content: 'There is no bet to raise yet. Place a bet or check if checking is available.', ephemeral: true })
    }

    if (action === 'bet' || action === 'raise') {
        const min = action === 'raise' ? table.betting.currentBet + table.betting.minRaise : CONFIG.minBet
        const modal = new ModalBuilder()
            .setCustomId(`oldmaid:${table.id}:${action}Submit`)
            .setTitle(action === 'raise' ? 'Raise Amount' : 'Bet Amount')
            .addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('amount')
                    .setLabel('Amount')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setPlaceholder(`${min} or more`)
            ))
        await interaction.showModal(modal)
        return
    }

    await interaction.reply({ content: 'That betting action is not available right now.', ephemeral: true })
}

const handleBetSubmit = async (interaction, table, action) => {
    const player = currentPlayer(table)
    if (!player || player.id !== interaction.user.id) return interaction.reply({ content: 'It is not your turn.', ephemeral: true })
    if (table.phase !== 'betting') return interaction.reply({ content: 'Betting is not active right now.', ephemeral: true })

    const amount = Number.parseInt(interaction.fields.getTextInputValue('amount'), 10)
    if (!Number.isInteger(amount) || amount <= 0) return interaction.reply({ content: 'Amount must be a valid positive integer.', ephemeral: true })

    if (action === 'betSubmit') {
        if (table.betting.currentBet !== 0) return interaction.reply({ content: 'A bet already exists. Use raise instead.', ephemeral: true })
        if (amount < CONFIG.minBet) return interaction.reply({ content: `Minimum bet is ${CONFIG.minBet} credits.`, ephemeral: true })
    }

    if (action === 'raiseSubmit') {
        if (table.betting.currentBet === 0) return interaction.reply({ content: 'There is no bet to raise yet.', ephemeral: true })
        if (amount < table.betting.currentBet + table.betting.minRaise) {
            return interaction.reply({ content: `Minimum raise is ${table.betting.currentBet + table.betting.minRaise} total credits.`, ephemeral: true })
        }
    }

    if (amount <= player.currentBet) return interaction.reply({ content: 'Amount must be higher than your current bet.', ephemeral: true })
    const needed = amount - player.currentBet
    if (needed > player.stack) return interaction.reply({ content: `Insufficient balance. You have ${player.stack} credits available at this table.`, ephemeral: true })

    const previousBet = table.betting.currentBet
    await commitCredits(table, player, needed)
    table.betting.currentBet = amount
    if (amount > previousBet) {
        table.betting.allowCheck = false
        if (previousBet > 0) table.betting.minRaise = amount - previousBet
        resetBettingActions(table, player)
    }
    player.acted = true

    await interaction.reply({ content: `${previousBet === 0 ? 'Bet' : 'Raised to'} ${amount} credits.`, ephemeral: true })
    await proceedAfterBettingAction(table, `${player.name} ${previousBet === 0 ? 'bet' : 'raised to'} ${amount} credits.`)
}

const commitCredits = async (table, player, amount) => {
    if (amount <= 0) return 0
    if (amount > player.stack) throw new Error(`Insufficient balance. ${player.name} only has ${player.stack} credits available.`)
    await applyCreditChanges([{ discordId: player.id, amount: -amount }], `Old Maid wager ${table.id}`)
    player.stack -= amount
    player.currentBet += amount
    player.totalCommitted += amount
    table.pot += amount
    return amount
}

const resetBettingActions = (table, actor) => {
    for (const player of activePlayers(table)) {
        if (player.id !== actor.id) player.acted = false
    }
}

const proceedAfterBettingAction = async (table, announcement = null) => {
    clearTimer(table)
    if (await maybeEndByFolds(table, announcement)) return

    const eligible = activePlayers(table)
    const done = eligible.every(player => player.acted && player.currentBet === table.betting.currentBet)
    if (done) {
        table.phase = 'drawing'
        table.betting = null
        table.drawTurnsSinceBet = 0
        table.currentTurn = nextActiveSeat(table, previousActiveSeat(table, table.currentTurn), true)
        if (await maybeEndByCards(table, announcement)) return
        await updateGameMessage(table, announcement ? `${announcement}\nDrawing begins.` : 'Drawing begins.')
        armTimer(table)
        return
    }

    table.currentTurn = nextActiveSeat(table, table.currentTurn)
    await updateGameMessage(table, announcement)
    armTimer(table)
}

const drawAction = async (interaction, table, player) => {
    if (player.hand.length === 0) return interaction.reply({ content: 'You have no cards left, so your turn is skipped.', ephemeral: true })
    const targetSeat = nextDrawableTargetSeat(table, table.currentTurn)
    const target = table.players[targetSeat]
    if (!target || target.id === player.id || target.hand.length === 0) {
        await interaction.reply({ content: 'There is no valid player to draw from.', ephemeral: true })
        await maybeEndByCards(table, 'No drawable target remained.')
        return
    }

    const drawnIndex = crypto.randomInt(target.hand.length)
    const [drawn] = target.hand.splice(drawnIndex, 1)
    player.hand.push(drawn)
    const pairs = removePairs(player)
    const targetPairs = removePairs(target)

    table.drawTurnsSinceBet += 1
    await interaction.reply({ content: `You drew one hidden relic from ${target.name}.`, ephemeral: true })

    const announcements = [`${player.name} drew from ${target.name}.`]
    if (pairs > 0) announcements.push(`${player.name} formed ${pairs} pair${pairs === 1 ? '' : 's'}.`)
    if (targetPairs > 0) announcements.push(`${target.name} formed ${targetPairs} pair${targetPairs === 1 ? '' : 's'}.`)

    if (await maybeEndByCards(table, announcements.join('\n'))) return

    const nextSeat = nextActiveSeat(table, table.currentTurn, true)
    table.currentTurn = nextSeat

    const threshold = Math.max(1, drawingPlayers(table).length) * 2
    if (table.drawTurnsSinceBet >= threshold && activePlayers(table).length > 1) {
        startBettingRound(table, table.currentTurn, { opening: false, allowOpeningCheck: true })
        await updateGameMessage(table, `${announcements.join('\n')}\nTwo full passes are complete. Wagers reopen.`)
        armTimer(table)
        return
    }

    await updateGameMessage(table, announcements.join('\n'))
    armTimer(table)
}

const proceedAfterFold = async (table, announcement = null) => {
    clearTimer(table)
    if (await maybeEndByFolds(table, announcement)) return
    if (table.phase === 'betting') await proceedAfterBettingAction(table, announcement)
    else {
        table.currentTurn = nextActiveSeat(table, table.currentTurn, true)
        if (await maybeEndByCards(table, announcement)) return
        if (currentPlayer(table)?.folded || currentPlayer(table)?.hand.length === 0) {
            table.currentTurn = nextActiveSeat(table, table.currentTurn, true)
        }
        await updateGameMessage(table, announcement)
        armTimer(table)
    }
}

const maybeEndByFolds = async (table, announcement = null) => {
    const remaining = activePlayers(table)
    if (remaining.length !== 1) return false

    const winner = remaining[0]
    if (table.pot > 0) await applyCreditChanges([{ discordId: winner.id, amount: table.pot }], `Old Maid uncontested payout ${table.id}`)
    await closeTable(table, 'Old Maid Complete', [announcement, `<@${winner.id}> wins ${table.pot} credits because everyone else folded.`].filter(Boolean).join('\n'))
    return true
}

const maybeEndByCards = async (table, announcement = null) => {
    const withCards = drawingPlayers(table)
    if (withCards.length > 1) return false

    const loser = withCards[0] || null
    const winners = activePlayers(table).filter(player => player.id !== loser?.id)
    if (!loser || winners.length === 0) {
        const fallback = activePlayers(table)[0]
        if (fallback && table.pot > 0) await applyCreditChanges([{ discordId: fallback.id, amount: table.pot }], `Old Maid payout ${table.id}`)
        await closeTable(table, 'Old Maid Complete', [announcement, fallback ? `<@${fallback.id}> claims ${table.pot} credits.` : 'No winner remained.'].filter(Boolean).join('\n'))
        return true
    }

    const share = Math.floor(table.pot / winners.length)
    let remainder = table.pot % winners.length
    const payouts = winners
        .filter(() => share > 0 || remainder > 0)
        .map(player => {
            const amount = share + (remainder > 0 ? 1 : 0)
            remainder -= remainder > 0 ? 1 : 0
            return { discordId: player.id, amount }
        })
        .filter(change => change.amount > 0)

    if (payouts.length) await applyCreditChanges(payouts, `Old Maid payout ${table.id}`)
    await closeTable(
        table,
        'Old Maid Complete',
        [
            announcement,
            `<@${loser.id}> was left with the Old Maid.`,
            `Winners split ${table.pot} credits: ${winners.map(player => `<@${player.id}>`).join(', ')}.`
        ].filter(Boolean).join('\n')
    )
    return true
}

const closeTable = async (table, title, description) => {
    clearTimer(table)
    table.phase = 'ended'
    saveTable(table)
    const channel = await table.client.channels.fetch(table.channelId)
    const message = await channel.messages.fetch(table.messageId)
    await message.edit({
        embeds: [new EmbedBuilder().setTitle(title).setColor(0xd4af37).setDescription(description || 'The table is closed.')],
        components: endedComponents(table)
    })
    deleteTable(table)
}

const clearTimer = (table) => {
    if (table.timer) clearTimeout(table.timer)
    table.timer = null
}

const armTimer = (table) => {
    clearTimer(table)
    if (!['betting', 'drawing'].includes(table.phase) || !currentPlayer(table)) return

    table.timer = setTimeout(async () => {
        try {
            const player = currentPlayer(table)
            if (!player) return
            player.folded = true
            player.acted = true
            await proceedAfterFold(table, `${player.name} timed out and folded.`)
        } catch (err) {
            log('error', 'Old Maid timer failed', { tableId: table.id, error: err.message })
        }
    }, CONFIG.turnSeconds * 1000)
}

export const initOldMaid = async (client) => {
    ensureStorage()
    restoreTables()
    for (const table of tables.values()) {
        table.client = client
        if (['betting', 'drawing'].includes(table.phase)) armTimer(table)
    }
    client.on('guildMemberRemove', member => {
        handleMemberRemoved(member).catch(err => log('error', 'Failed to handle member leave', { error: err.message }))
    })
    log('info', 'Old Maid system initialized', { tables: tables.size })
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

        if (!player.folded) {
            player.folded = true
            player.acted = true
            await proceedAfterFold(table, `${player.name} left the server and folded.`)
        }
    }
}
