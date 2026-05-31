import { Client, GatewayIntentBits } from 'discord.js'
import dotenv from 'dotenv'
import { handlePokerInteraction, handlePokerMessage, initPoker } from './poker/index.js'

dotenv.config()

if (!process.env.POKER_DISCORD_TOKEN) {
    throw new Error('POKER_DISCORD_TOKEN is required for the separate poker bot')
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
})

client.on('messageCreate', async (message) => {
    if (message.author.bot) return
    await handlePokerMessage(message)
})

client.on('interactionCreate', async (interaction) => {
    await handlePokerInteraction(interaction)
})

client.once('clientReady', () => {
    console.log(`Poker bot logged in as ${client.user.tag}`)
    initPoker(client).catch(err => console.error('Failed to initialize poker system:', err))
})

client.login(process.env.POKER_DISCORD_TOKEN)
