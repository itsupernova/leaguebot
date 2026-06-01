import { Client, GatewayIntentBits } from 'discord.js'
import dotenv from 'dotenv'
import { handlePokerInteraction, handlePokerMessage, initPoker } from './poker/index.js'
import { handleOldMaidInteraction, handleOldMaidMessage, initOldMaid } from './oldmaid/index.js'

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
    if (await handlePokerMessage(message)) return
    await handleOldMaidMessage(message)
})

client.on('interactionCreate', async (interaction) => {
    if (await handlePokerInteraction(interaction)) return
    await handleOldMaidInteraction(interaction)
})

client.once('clientReady', () => {
    console.log(`Poker bot logged in as ${client.user.tag}`)
    initPoker(client).catch(err => console.error('Failed to initialize poker system:', err))
    initOldMaid(client).catch(err => console.error('Failed to initialize Old Maid system:', err))
})

client.login(process.env.POKER_DISCORD_TOKEN)
