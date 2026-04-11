import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js'
import dotenv from 'dotenv'
import axios from 'axios'
import { getPlayer } from './utils/api.js'
import { isAdmin } from './utils/isAdmin.js'

dotenv.config()
const API = process.env.API_BASE_URL
const gymSetupSessions = new Map()
const eliteSetupSessions = new Map()

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.MessageContent]
})

client.on('messageCreate', async (message) => {
    if (message.author.bot) return

    // 1. Handle Active Interactive Sessions (responses without '!')
    if (gymSetupSessions.has(message.author.id) && !message.content.startsWith('!')) {
        const session = gymSetupSessions.get(message.author.id)
        const content = message.content.trim()

        try {
            if (session.step === 1) {
                session.data.name = content
                session.step = 2
                return message.reply('🎨 Enter the **Gym Type** (e.g. Fire, Water):')
            }

            if (session.step === 2) {
                session.data.type = content
                session.step = 3
                return message.reply('⚔️ Enter the **Battle Style** (Single / Double):')
            }

            if (session.step === 3) {
                session.data.style = content
                session.step = 4
                return message.reply('👤 Mention the **Gym Leader**:')
            }

            if (session.step === 4) {
                const mention = message.mentions.users.first()
                if (!mention) return message.reply('❌ Please mention a valid user')

                session.data.leaderDiscordId = mention.id
                session.step = 5
                return message.reply('🏅 Enter the **Badge Name**:')
            }

            if (session.step === 5) {
                session.data.badge = content
                await axios.post(`${API}/gym/create`, session.data)
                gymSetupSessions.delete(message.author.id)

                return message.reply(
                    `🏛 Gym Created!\n` +
                    `Name: ${session.data.name}\n` +
                    `Type: ${session.data.type}\n` +
                    `Style: ${session.data.style}\n` +
                    `Badge: ${session.data.badge}`
                )
            }
        } catch (err) {
            gymSetupSessions.delete(message.author.id)
            return message.reply(err.response?.data?.error || '❌ Failed to complete gym setup')
        }
    }

    // 1.1 Handle Elite Four Setup Sessions
    if (eliteSetupSessions.has(message.author.id) && !message.content.startsWith('!')) {
        const session = eliteSetupSessions.get(message.author.id)
        const content = message.content.trim()

        try {
            if (session.step === 1) {
                const mention = message.mentions.users.first()
                if (!mention) return message.reply('❌ Please mention a valid user to assign as Elite Four:')
                
                session.data.playerDiscordId = mention.id
                session.step = 2
                return message.reply('🎨 Enter the **Elite Four Type** (e.g. Dragon, Steel):')
            }

            if (session.step === 2) {
                session.data.type = content
                session.step = 3
                return message.reply('⚔️ Enter the **Battle Style** (Single / Double):')
            }

            if (session.step === 3) {
                session.data.style = content
                
                await axios.post(`${API}/elite-four/create`, session.data)
                eliteSetupSessions.delete(message.author.id)

                return message.reply(
                    `🏆 **Elite Four Member Assigned!**\n` +
                    `👤 Player: <@${session.data.playerDiscordId}>\n` +
                    `🎨 Type: ${session.data.type}\n` +
                    `⚔️ Style: ${session.data.style}`
                )
            }
        } catch (err) {
            eliteSetupSessions.delete(message.author.id)
            return message.reply(err.response?.data?.error || '❌ Failed to complete Elite Four setup')
        }
    }

    if (!message.content.startsWith('!')) return

    const args = message.content.slice(1).split(' ')
    const command = args[0]

    try {

        // ⚔️ Submit Battle
        if (command === 'submit') {
            const replay = args[1]
            const category = args[2] || 'casual'

            await axios.post(`${API}/battle/submit`, {
                replay_link: replay,
                category
            })

            return message.reply('✅ Battle recorded successfully!')
        }

        // 👤 Player Profile
        if (command === 'profile') {
            const mention = message.mentions.users.first() || message.author

            try {
                const playerRes = await axios.get(`${API}/player/by-discord/${mention.id}`)
                const player = playerRes.data

                const res = await axios.get(`${API}/player/${player.id}/full`)
                const p = res.data

                const badges = p.badges.length
                    ? p.badges.map(b => `🏅 ${b.badge.name}`).join(', ')
                    : 'None'

                const embed = new EmbedBuilder()
                    .setTitle(`👤 ${p.name}`)
                    .setThumbnail(mention.displayAvatarURL())
                    .addFields(
                        { name: '⚡ Rating', value: `${p.rating}`, inline: true },
                        { name: '🏆 Rank', value: `#${p.rank}`, inline: true },
                        { name: '🎖 Class', value: p.class, inline: true },
                        { name: '🏳 Clan', value: p.clan?.name || 'None', inline: true },
                        { name: '📦 Box Size', value: `${p.pokemon.length}/10`, inline: true },
                        { name: '🔐 Special Box', value: `${p.special_pokemon.length}/4`, inline: true },
                        { name: '🎖 Badges', value: badges.slice(0, 1024) }
                    )

                return message.reply({ embeds: [embed] })

            } catch (err) {
                return message.reply('❌ Failed to fetch profile')
            }
        }

        // 📊 Leaderboard
        if (command === 'lb') {
            const res = await axios.get(`${API}/leaderboard/players`)

            const top = res.data
                .slice(0, 10)
                .map((p, i) => `${i + 1}. ${p.name} (${p.rating})`)
                .join('\n')

            return message.reply(`🏆 Leaderboard:\n${top}`)
        }

        // ⚔️ Start Raid
        if (command === 'raid') {
            const attacker = args[1]
            const defender = args[2]

            const res = await axios.post(`${API}/raid/start`, {
                attackerClanId: attacker,
                defenderClanId: defender
            })

            return message.reply(`⚔️ Raid started! ID: ${res.data.raid.id}`)
        }

        // 🏹 Start Siege
        if (command === 'siege') {
            const clanId = args[1]
            const gymId = args[2]

            const res = await axios.post(`${API}/siege/start`, {
                attackerClanId: clanId,
                gymId
            })

            return message.reply(`🏹 Siege started! ID: ${res.data.id}`)
        }

        // 👑 Start Rebellion
        if (command === 'rebellion') {
            const clanId = args[1]

            const res = await axios.post(`${API}/rebellion/start`, {
                clanId
            })

            return message.reply(`👑 Rebellion started! ID: ${res.data.rebellion.id}`)
        }

        // 🧾 Weekly Report
        if (command === 'report') {
            const res = await axios.post(`${API}/report/weekly`)

            const text = res.data.reports
                .map(r => `🏛 ${r.clan} | ${r.total_points} pts | Δ ${r.change}`)
                .join('\n')

            return message.reply(`📊 Weekly Report:\n${text}`)
        }

        // ⚙️ Clan Update (ADMIN)
        if (command === 'update') {
            await axios.post(`${API}/clan/update`)
            return message.reply('⚡ Clan points updated!')
        }

        // 🪪 Register
        if (command === 'register') {
            const showdown = args[1]

            if (!showdown) {
                return message.reply('❌ Usage: !register <showdown_name>')
            }

            try {
                await axios.post(`${API}/player/register`, {
                    discord_id: message.author.id,
                    name: message.author.username,
                    showdown_name: showdown
                })

                return message.reply('✅ You are now registered as a trainer!')
            } catch (err) {
                const errorMsg = err.response?.data?.error || err.message
                console.error('Registration Error:', errorMsg)
                return message.reply(`❌ Registration failed: **${errorMsg}**`)
            }
        }

        // 📝 Edit Showdown Name
        if (command === 'psedit') {
            const showdown = args[1]

            if (!showdown) {
                return message.reply('❌ Usage: !psedit <new_showdown_name>')
            }

            try {
                const res = await axios.post(`${API}/player/update-showdown`, {
                    discord_id: message.author.id,
                    showdown_name: showdown
                })

                return message.reply(`✅ Showdown name updated to **${res.data.showdown_name}**!`)
            } catch (err) {
                return message.reply(err.response?.data?.error || '❌ Failed to update Showdown name')
            }
        }

        // 🤝 Trade
        if (command === 'trade') {
            const mention = message.mentions.users.first()
            const pokemonId = args[2]

            if (!mention || !pokemonId) {
                return message.reply('❌ Usage: !trade @user <pokemonId>')
            }

            const sender = await getPlayer(message.author.id)
            const receiver = await getPlayer(mention.id)

            const res = await axios.post(`${API}/trade/start`, {
                fromPlayerId: sender.id,
                toPlayerId: receiver.id,
                pokemonId
            })

            const tradeId = res.data.id

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`accept_${tradeId}`)
                    .setLabel('Accept')
                    .setStyle(ButtonStyle.Success),

                new ButtonBuilder()
                    .setCustomId(`reject_${tradeId}`)
                    .setLabel('Reject')
                    .setStyle(ButtonStyle.Danger)
            )

            await mention.send({
                content: `🤝 Trade request from **${message.author.username}**\nPokémon ID: ${pokemonId}\n⏱ Expires in 1 minute`,
                components: [row]
            })

            return message.reply('📨 Trade request sent via DM!')
        }

        // 📦 Register Box
        if (command === 'registerbox') {
            const url = args[1]

            if (!url) {
                return message.reply('❌ Usage: !registerbox <pokepaste_url>')
            }

            try {
                const res = await axios.post(`${API}/player/register-box`, {
                    discordId: message.author.id,
                    url
                })

                return message.reply(
                    `📦 Box registered!\nPokémon (${res.data.count}):\n${res.data.pokemon.join(', ')}`
                )

            } catch (err) {
                return message.reply(err.response?.data?.error || '❌ Failed to register box')
            }
        }

        // 🔐 Register Special
        if (command === 'registerspecial') {
            const url = args[1]

            if (!url) {
                return message.reply('❌ Usage: !registerspecial <pokepaste_url>')
            }

            try {
                const res = await axios.post(`${API}/player/register-special`, {
                    discordId: message.author.id,
                    url
                })

                return message.reply(
                    `🔐 Special box registered (${res.data.role})!\n` +
                    `Pokémon (${res.data.count}):\n${res.data.pokemon.join(', ')}`
                )

            } catch (err) {
                return message.reply(err.response?.data?.error || '❌ Failed to register special box')
            }
        }

        // 📦 View Box
        if (command === 'box') {
            const mention = message.mentions.users.first() || message.author

            try {
                const player = await getPlayer(mention.id)
                const res = await axios.get(`${API}/player/${player.id}/box`)
                const mons = res.data.pokemon

                if (!mons.length) {
                    return message.reply('📦 This box is empty!')
                }

                const list = mons.map((p, i) => `${i + 1}. ${p.pokemon_name}`).join('\n')

                const embed = new EmbedBuilder()
                    .setTitle(`📦 ${res.data.name}'s Box`)
                    .setDescription(list)

                return message.reply({ embeds: [embed] })

            } catch (err) {
                return message.reply('❌ Failed to fetch box')
            }
        }

        // 🔐 View Special Box
        if (command === 'specialbox') {
            const mention = message.mentions.users.first() || message.author

            try {
                const player = await getPlayer(mention.id)
                const res = await axios.get(`${API}/player/${player.id}/special-box`)
                const mons = res.data.pokemon

                if (!mons.length) {
                    return message.reply('🔐 No special Pokémon registered!')
                }

                const list = mons.map((p, i) => `${i + 1}. ${p.pokemon_name}`).join('\n')

                const embed = new EmbedBuilder()
                    .setTitle(`🔐 ${res.data.name}'s Special Box (${res.data.role})`)
                    .setDescription(list)

                return message.reply({ embeds: [embed] })

            } catch (err) {
                return message.reply('❌ Failed to fetch special box')
            }
        }

        // 🏛 Register Clan
        if (command === 'registerclan') {
            const clanName = args.slice(1).join(' ')

            if (!clanName) {
                return message.reply('❌ Usage: !registerclan <clan_name>')
            }

            try {
                await axios.post(`${API}/clan/register`, {
                    discordId: message.author.id,
                    clanName
                })

                return message.reply(`🏛 Clan **${clanName}** created! You are its first member.`)

            } catch (err) {
                return message.reply(err.response?.data?.error || '❌ Failed to create clan')
            }
        }

        // 🤝 Join Clan
        if (command === 'joinclan') {
            const clanName = args.slice(1).join(' ')

            if (!clanName) {
                return message.reply('❌ Usage: !joinclan <clan_name>')
            }

            try {
                await axios.post(`${API}/clan/join`, {
                    discordId: message.author.id,
                    clanName
                })

                return message.reply(`🤝 You joined **${clanName}**!`)

            } catch (err) {
                return message.reply(err.response?.data?.error || '❌ Failed to join clan')
            }
        }

        // 👑 Transfer Leadership
        if (command === 'transfer') {
            const mention = message.mentions.users.first()

            if (!mention) {
                return message.reply('❌ Usage: !transfer @player')
            }

            try {
                await axios.post(`${API}/clan/transfer`, {
                    discordId: message.author.id,
                    targetDiscordId: mention.id
                })

                return message.reply(`👑 Leadership transferred to ${mention.username}!`)

            } catch (err) {
                return message.reply(err.response?.data?.error || '❌ Transfer failed')
            }
        }

        // 🚪 Leave Clan
        if (command === 'leave') {
            try {
                await axios.post(`${API}/clan/leave`, {
                    discordId: message.author.id
                })

                return message.reply('🚪 You have left your clan.')

            } catch (err) {
                return message.reply(
                    err.response?.data?.error || '❌ Failed to leave clan'
                )
            }
        }

        // 🔥 Fire Member
        if (command === 'fire') {
            const mention = message.mentions.users.first()

            if (!mention) {
                return message.reply('❌ Usage: !fire @player')
            }

            try {
                await axios.post(`${API}/clan/fire`, {
                    discordId: message.author.id,
                    targetDiscordId: mention.id
                })

                return message.reply(`🔥 ${mention.username} has been removed from the clan.`)

            } catch (err) {
                return message.reply(
                    err.response?.data?.error || '❌ Failed to remove member'
                )
            }
        }

        // 🏛 Register Gym (interactive)
        if (command === 'regym') {
            if (!isAdmin(message.member, message.author.id)) {
                return message.reply('❌ Admin only')
            }

            if (gymSetupSessions.has(message.author.id)) {
                return message.reply('⚠️ You are already creating a gym. Cancel with `!cancelgym`')
            }

            gymSetupSessions.set(message.author.id, {
                step: 1,
                data: {}
            })
            setTimeout(() => {
                if (gymSetupSessions.has(message.author.id)) {
                    gymSetupSessions.delete(message.author.id)
                }
            }, 2 * 60 * 1000)

            return message.reply('🏛 Enter the **Gym Name**:')
        }

        // ❌ Cancel Gym Setup
        if (command === 'cancelgym') {
            if (gymSetupSessions.has(message.author.id)) {
                gymSetupSessions.delete(message.author.id)
                return message.reply('🛑 Gym setup cancelled.')
            }
            return message.reply('❌ You are not currently creating a gym.')
        }

        // 🏆 Register Elite Four (interactive)
        if (command === 'signelite') {
            if (!isAdmin(message.member, message.author.id)) {
                return message.reply('❌ Admin only')
            }

            if (eliteSetupSessions.has(message.author.id)) {
                return message.reply('⚠️ You are already assigning an Elite Four. Cancel with `!cancelelite`')
            }

            eliteSetupSessions.set(message.author.id, {
                step: 1,
                data: {}
            })
            setTimeout(() => {
                if (eliteSetupSessions.has(message.author.id)) {
                    eliteSetupSessions.delete(message.author.id)
                }
            }, 2 * 60 * 1000)

            return message.reply('🏆 Mention the player to be assigned as **Elite Four**:')
        }

        // ❌ Cancel Elite Four Setup
        if (command === 'cancelelite') {
            if (eliteSetupSessions.has(message.author.id)) {
                eliteSetupSessions.delete(message.author.id)
                return message.reply('🛑 Elite Four setup cancelled.')
            }
            return message.reply('❌ You are not currently assigning an Elite Four.')
        }


        // 🔁 Set Gym Leader
        if (command === 'set') {
            const mention = message.mentions.users.first()
            const gymName = args.slice(2).join(' ')

            if (!isAdmin(message.member, message.author.id)) {
                return message.reply('❌ Admin only')
            }

            if (!mention || !gymName) {
                return message.reply('❌ Usage: !set @player <gym_name>')
            }

            try {
                await axios.post(`${API}/clan/set-gym-leader`, {
                    discordId: message.author.id,
                    targetDiscordId: mention.id,
                    gymName
                })

                return message.reply(
                    `🏛 ${mention.username} is now the leader of **${gymName}**!`
                )

            } catch (err) {
                return message.reply(
                    err.response?.data?.error || '❌ Failed to assign gym leader'
                )
            }
        }

        // 🔄 Change Gym Clan
        if (command === 'change') {
            if (!isAdmin(message.member, message.author.id)) {
                return message.reply('❌ Admin only')
            }

            const gymName = args[1]
            const clanName = args.slice(2).join(' ')

            if (!gymName || !clanName) {
                return message.reply('❌ Usage: !change <gym_name> <clan_name>')
            }

            try {
                await axios.post(`${API}/gym/change-clan`, {
                    gymName,
                    clanName
                })

                return message.reply(
                    `⚡ Gym **${gymName}** now belongs to **${clanName}**!`
                )

            } catch (err) {
                return message.reply(
                    err.response?.data?.error || '❌ Failed to change gym ownership'
                )
            }
        }

        // 📜 Gym List
        if (command === 'gymlist') {
            try {
                const res = await axios.get(`${API}/gym/list`)
                const gyms = res.data

                if (!gyms.length) {
                    return message.reply('🏛 No gyms registered yet.')
                }

                const list = gyms.map((g, i) => {
                    return `${i + 1}. **${g.name}**\n` +
                        `👑 Leader: ${g.leader?.name || 'None'}\n` +
                        `🎨 Type: ${g.type}\n` +
                        `🏳 Clan: ${g.clan?.name || 'None'}`
                }).join('\n\n')

                const embed = new EmbedBuilder()
                    .setTitle('🏛 Requiem League Gyms')
                    .setDescription(list)

                return message.reply({ embeds: [embed] })

            } catch (err) {
                return message.reply('❌ Failed to fetch gyms')
            }
        }

        // 🏆 Elite Four List
        if (command === 'elitelist') {
            try {
                const res = await axios.get(`${API}/elite-four/list`)
                const e4Members = res.data

                if (!e4Members.length) {
                    return message.reply('🏆 No Elite Four members registered yet.')
                }

                const list = e4Members.map((e4, i) => {
                    return `${i + 1}. **${e4.player.name}**\n` +
                        `🎨 Type: ${e4.type}\n` +
                        `⚔️ Style: ${e4.style}`
                }).join('\n\n')

                const embed = new EmbedBuilder()
                    .setTitle('🏆 Requiem League Elite Four')
                    .setDescription(list)

                return message.reply({ embeds: [embed] })

            } catch (err) {
                return message.reply('❌ Failed to fetch Elite Four list')
            }
        }

        // 🏛 Gym Info
        if (command === 'gym') {
            const gymName = args.slice(1).join(' ')

            if (!gymName) {
                return message.reply('❌ Usage: !gym <gym_name>')
            }

            try {
                const res = await axios.get(`${API}/gym/${encodeURIComponent(gymName)}`)
                const gym = res.data
                const leader = gym.leader

                const box = leader.pokemon.map(p => `• ${p.pokemon_name}`).join('\n') || 'None'
                const special = leader.special_pokemon.map(p => `• ${p.pokemon_name}`).join('\n') || 'None'

                const embed = new EmbedBuilder()
                    .setTitle(`🏛 ${gym.name}`)
                    .addFields(
                        { name: '👑 Leader', value: leader?.name || 'None', inline: true },
                        { name: '🎨 Type', value: gym.type, inline: true },
                        { name: '⚔️ Style', value: gym.style, inline: true },
                        { name: '🏳 Clan', value: gym.clan?.name || 'None', inline: true },
                        { name: '📦 Leader Box', value: box.slice(0, 1024) },
                        { name: '🔐 Special Box', value: special.slice(0, 1024) }
                    )

                return message.reply({ embeds: [embed] })

            } catch (err) {
                return message.reply(err.response?.data?.error || '❌ Failed to fetch gym')
            }
        }

        // 🏅 Give Badge
        if (command === 'givebadge') {
            const mention = message.mentions.users.first()

            if (!mention) {
                return message.reply('❌ Usage: !givebadge @player')
            }

            try {
                const res = await axios.post(`${API}/gym/give-badge`, {
                    leaderDiscordId: message.author.id,
                    targetDiscordId: mention.id
                })

                return message.reply(
                    `🏅 ${mention.username} received the **${res.data.badge}**!`
                )

            } catch (err) {
                return message.reply(
                    err.response?.data?.error || '❌ Failed to give badge'
                )
            }
        }

        // 🗑️ Take Badge (ADMIN)
        if (command === 'takebadge') {
            if (!isAdmin(message.member, message.author.id)) {
                return message.reply('❌ Admin only')
            }

            const mention = message.mentions.users.first()
            if (!mention) {
                return message.reply('❌ Usage: !takebadge <badge_name> @player')
            }

            const badgeNameStr = message.content
                .replace('!takebadge', '')
                .replace(/<@!?\d+>/g, '') 
                .trim()

            if (!badgeNameStr) {
                return message.reply('❌ Usage: !takebadge <badge_name> @player')
            }

            try {
                const res = await axios.post(`${API}/gym/take-badge`, {
                    targetDiscordId: mention.id,
                    badgeName: badgeNameStr
                })

                if (res.data.success) {
                    return message.reply(`🗑️ **${res.data.badge}** badge has been taken from **${res.data.player}**!`)
                }

            } catch (err) {
                return message.reply(err.response?.data?.error || '❌ Failed to take badge')
            }
        }

        // 🎁 Give Pokémon (ADMIN)
        if (command === 'give') {
            if (!isAdmin(message.member, message.author.id)) {
                return message.reply('❌ Admin only')
            }

            const mention = message.mentions.users.first()
            const pokemonName = args.slice(2).join(' ')

            if (!mention || !pokemonName) {
                return message.reply('❌ Usage: !give @player <pokemon_name>')
            }

            try {
                const res = await axios.post(`${API}/player/give-pokemon`, {
                    targetDiscordId: mention.id,
                    pokemonName
                })

                if (res.data.success) {
                    return message.reply(`🎁 **${res.data.pokemon}** has been added to **${res.data.player}**'s box!`)
                }

            } catch (err) {
                return message.reply(err.response?.data?.error || '❌ Failed to give Pokémon')
            }
        }

        // 🗑️ Take Pokémon (ADMIN)
        if (command === 'take') {
            if (!isAdmin(message.member, message.author.id)) {
                return message.reply('❌ Admin only')
            }

            const mention = message.mentions.users.first()
            const pokemonName = args.slice(2).join(' ')

            if (!mention || !pokemonName) {
                return message.reply('❌ Usage: !take @player <pokemon_name>')
            }

            try {
                const res = await axios.post(`${API}/player/take-pokemon`, {
                    targetDiscordId: mention.id,
                    pokemonName
                })

                if (res.data.success) {
                    return message.reply(`🗑️ **${res.data.pokemon}** has been removed from **${res.data.player}**'s box!`)
                }

            } catch (err) {
                return message.reply(err.response?.data?.error || '❌ Failed to take Pokémon')
            }
        }

        // ➕ Add Points
        if (command === 'add') {
            if (!isAdmin(message.member, message.author.id)) {
                return message.reply('❌ Admin only')
            }

            const points = parseInt(args[1])
            const clanName = args.slice(2).join(' ')

            if (!points || !clanName) {
                return message.reply('❌ Usage: !add <points> <clan_name>')
            }

            try {
                const res = await axios.post(`${API}/clan/modify-points`, {
                    clanName,
                    points,
                    type: 'add'
                })

                return message.reply(
                    `➕ ${points} points added to **${res.data.clan}**\n` +
                    `New Total: ${res.data.points}`
                )

            } catch (err) {
                return message.reply(
                    err.response?.data?.error || '❌ Failed to add points'
                )
            }
        }

        // ➖ Cut Points
        if (command === 'cut') {
            if (!isAdmin(message.member, message.author.id)) {
                return message.reply('❌ Admin only')
            }

            const points = parseInt(args[1])
            const clanName = args.slice(2).join(' ')

            if (!points || !clanName) {
                return message.reply('❌ Usage: !cut <points> <clan_name>')
            }

            try {
                const res = await axios.post(`${API}/clan/modify-points`, {
                    clanName,
                    points,
                    type: 'cut'
                })

                return message.reply(
                    `➖ ${points} points removed from **${res.data.clan}**\n` +
                    `New Total: ${res.data.points}`
                )

            } catch (err) {
                return message.reply(
                    err.response?.data?.error || '❌ Failed to cut points'
                )
            }
        }

        // 🏛 Clan Profile
        if (command === 'clan') {
            const clanName = args.slice(1).join(' ')

            try {
                const res = await axios.get(`${API}/clan/profile`, {
                    params: {
                        clanName: clanName || null,
                        discordId: message.author.id
                    }
                })

                const clan = res.data

                const members = clan.members
                    .map(m => m.is_clan_leader ? `👑 ${m.name}` : m.name)
                    .join(', ') || 'None'

                const gyms = clan.gyms
                    .map(g => `• ${g.name} (${g.type}) - ${g.leader?.name || 'No leader'}`)
                    .join('\n') || 'None'

                const embed = new EmbedBuilder()
                    .setTitle(`🏛 ${clan.name}`)
                    .addFields(
                        { name: '⚡ Clan Points', value: `${clan.clan_points}`, inline: true },
                        { name: '📈 Level', value: `${clan.level}`, inline: true },
                        { name: '👥 Members', value: members.slice(0, 1024) },
                        { name: '🏛 Gyms Controlled', value: gyms.slice(0, 1024) }
                    )

                return message.reply({ embeds: [embed] })

            } catch (err) {
                return message.reply(
                    err.response?.data?.error || '❌ Failed to fetch clan profile'
                )
            }
        }

        // 🎨 Set Gym Type
        if (command === 'settype') {
            if (!isAdmin(message.member, message.author.id)) {
                return message.reply('❌ Admin only')
            }

            const gymName = args.slice(1, -1).join(' ')
            const type = args.slice(-1).join(' ')

            if (!gymName || !type) {
                return message.reply('❌ Usage: !settype <gym_name> <type>')
            }

            try {
                await axios.post(`${API}/gym/set-type`, {
                    gymName,
                    type
                })

                return message.reply(`🎨 Gym **${gymName}** type updated to **${type}**`)

            } catch (err) {
                return message.reply(
                    err.response?.data?.error || '❌ Failed to update type'
                )
            }
        }

        // ⚔️ Set Gym Style
        if (command === 'setstyle') {
            if (!isAdmin(message.member, message.author.id)) {
                return message.reply('❌ Admin only')
            }

            const gymName = args.slice(1, -1).join(' ')
            const style = args.slice(-1).join(' ')

            if (!gymName || !style) {
                return message.reply('❌ Usage: !setstyle <gym_name> <single|double>')
            }

            try {
                await axios.post(`${API}/gym/set-style`, {
                    gymName,
                    style
                })

                return message.reply(`⚔️ Gym **${gymName}** style updated to **${style}**`)

            } catch (err) {
                return message.reply(
                    err.response?.data?.error || '❌ Failed to update style'
                )
            }
        }

        // ❓ Help
        if (command === 'help') {
            const embeds = []

            embeds.push(
                new EmbedBuilder()
                    .setTitle('👤 Player System')
                    .setColor(0x00ffcc)
                    .setDescription(
                        `🪪 **!register <showdown>** — Register as a trainer\n` +
                        `📦 **!registerbox <url>** — Register your Pokémon box\n` +
                        `🔐 **!registerspecial <url>** — Register special Pokémon (Gym/E4)\n\n` +
                        `👁️ **!box @player** — View player box\n` +
                        `🔒 **!specialbox @player** — View special box\n\n` +
                        `👤 **!profile @player** — Full trainer profile`
                    )
                    .setFooter({ text: 'Requiem League • Page 1/5' })
            )

            embeds.push(
                new EmbedBuilder()
                    .setTitle('🏛️ Clan System')
                    .setColor(0xff9900)
                    .setDescription(
                        `🏗️ **!registerclan <name>** — Create a clan\n` +
                        `👑 **!transfer @player** — Transfer leadership\n` +
                        `🚪 **!leave** — Leave your clan\n` +
                        `🔥 **!fire @player** — Kick member\n\n` +
                        `🏛️ **!clan [name]** — View clan profile\n\n` +
                        `➕ **!add <points> <clan>** *(Admin)*\n` +
                        `➖ **!cut <points> <clan>** *(Admin)*`
                    )
                    .setFooter({ text: 'Requiem League • Page 2/5' })
            )

            embeds.push(
                new EmbedBuilder()
                    .setTitle('🏟️ Gym System')
                    .setColor(0xff3333)
                    .setDescription(
                        `🏗️ **!regym** — Create a gym (interactive)\n` +
                        `🔁 **!set @player <gym>** — Change leader\n\n` +
                        `🎨 **!settype <gym> <type>** *(Admin)*\n` +
                        `⚔️ **!setstyle <gym> <single/double>** *(Admin)*\n` +
                        `🔄 **!change <gym> <clan>** *(Admin)*\n\n` +
                        `📜 **!gymlist** — List all gyms\n` +
                        `🏛️ **!gym <name>** — View gym details\n\n` +
                        `🎖 **!givebadge @player** — Give badge`
                    )
                    .setFooter({ text: 'Requiem League • Page 3/5' })
            )

            embeds.push(
                new EmbedBuilder()
                    .setTitle('⚔️ War System')
                    .setColor(0x9966ff)
                    .setDescription(
                        `🏛️ **!siege <gym>** — Attack a gym\n` +
                        `💣 **!raid <clan>** — Full clan war (9v9)\n` +
                        `👑 **!rebellion** — Challenge Elite 4\n\n` +
                        `🔥 Win battles → control gyms\n` +
                        `💀 Lose rebellion → heavy penalties`
                    )
                    .setFooter({ text: 'Requiem League • Page 4/5' })
            )

            embeds.push(
                new EmbedBuilder()
                    .setTitle('📊 System & Progression')
                    .setColor(0x00cc66)
                    .setDescription(
                        `⚡ Rating starts at **300 (ELO system)**\n` +
                        `🎖 Classes: Regular → Master\n\n` +
                        `📦 Max 10 Pokémon per player\n` +
                        `🔐 +4 for Gym Leaders / Elite 4\n\n` +
                        `🏛️ Clan Points = activity-based\n` +
                        `📈 Determines clan level & power\n\n` +
                        `📅 Weekly reports track performance`
                    )
                    .setFooter({ text: 'Requiem League • Page 5/5' })
            )

            let currentPage = 0
            const msg = await message.reply({ embeds: [embeds[currentPage]] })

            await msg.react('⬅️')
            await msg.react('➡️')

            const filter = (reaction, user) =>
                ['⬅️', '➡️'].includes(reaction.emoji.name) &&
                user.id === message.author.id

            const collector = msg.createReactionCollector({
                filter,
                time: 120000
            })

            collector.on('collect', (reaction, user) => {
                reaction.users.remove(user.id)

                if (reaction.emoji.name === '➡️') {
                    currentPage = (currentPage + 1) % embeds.length
                } else if (reaction.emoji.name === '⬅️') {
                    currentPage = (currentPage - 1 + embeds.length) % embeds.length
                }

                msg.edit({ embeds: [embeds[currentPage]] })
            })
        }

    } catch (err) {
        console.error(err.response?.data || err.message)
        message.reply('❌ Error processing command')
    }
})

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return

    const [action, tradeId] = interaction.customId.split('_')

    try {
        if (action === 'accept') {
            await axios.post(`${API}/trade/accept`, {
                tradeId,
                discordId: interaction.user.id
            })

            return interaction.update({
                content: '✅ Trade accepted!',
                components: []
            })
        }

        if (action === 'reject') {
            await axios.post(`${API}/trade/reject`, {
                tradeId,
                discordId: interaction.user.id
            })

            return interaction.update({
                content: '❌ Trade rejected',
                components: []
            })
        }

    } catch (err) {
        return interaction.reply({
            content: err.response?.data?.error || '⚠️ Trade failed',
            ephemeral: true
        })
    }
})

client.once('clientReady', () => {
    console.log(`🤖 Logged in as ${client.user.tag}`)
})

client.login(process.env.DISCORD_TOKEN)
