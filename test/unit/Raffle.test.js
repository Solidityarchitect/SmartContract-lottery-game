const { assert, expect } = require("chai")
const { network, deployments, ethers } = require("hardhat")
const { developmentChains, networkConfig } = require("../../helper-hardhat-config")

!developmentChains.includes(network.name)
    ? describe.skip
    : describe("Raffle Unit Tests", function () {
          let raffle, vrfCoordinatorV2Mock, raffleEntranceFee, deployer, interval
          const chainId = network.config.chainId

          beforeEach(async function () {
              deployer = (await getNamedAccounts()).deployer
              await deployments.fixture(["mocks", "raffle"])
              raffle = await ethers.getContract("Raffle", deployer) // Returns a new connection to the Raffle contract
              vrfCoordinatorV2Mock = await ethers.getContract("VRFCoordinatorV2Mock", deployer)
              raffleEntranceFee = await raffle.getEntranceFee()
              interval = await raffle.getInterval()
          })
          describe("constructor", function () {
              it("initializes the raffle correctly", async function () {
                  // Ideally we make our tests have just 1 assert per "it"
                  const raffleState = await raffle.getRaffleState()
                  assert.equal(raffleState.toString(), "0")
                  assert.equal(
                      interval.toString(),
                      networkConfig[network.config.chainId]["keepersUpdateInterval"]
                  )
              })
          })
          describe("enterRaffle", function () {
              it("reverts when you don't pay enough", async function () {
                  await expect(raffle.enterRaffle()).to.be.revertedWith(
                      "Raffle__SendMoreToEnterRaffle"
                  )
              })
              it("records player when they enter", async function () {
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  const playerFromContract = await raffle.getPlayer(0)
                  assert.equal(playerFromContract, deployer)
              })
              it("emits event on enter", async function () {
                  await expect(raffle.enterRaffle({ value: raffleEntranceFee })).to.emit(
                      raffle,
                      "RaffleEnter"
                  )
              })
              it("doesn't allow entrance when raffle is calculating", async function () {
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  // We pretend to be a Chainlink Keeper
                  await raffle.performUpkeep([])
                  await expect(raffle.enterRaffle({ value: raffleEntranceFee })).to.be.revertedWith(
                      "Raffle__RaffleNotOpen"
                  )
              })
          })
          describe("checkUpkeep", function () {
              it("returns false if people haven't sent any ETH", async function () {
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  const { upkeepNeeded } = await raffle.callStatic.checkUpkeep([])
                  assert(!upkeepNeeded)
              })
              it("returns false if raffle isn't open", async function () {
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  await raffle.performUpkeep([])
                  const raffleState = await raffle.getRaffleState()
                  const { upkeepNeeded } = await raffle.callStatic.checkUpkeep([])
                  assert.equal(raffleState.toString(), "1")
                  assert.equal(upkeepNeeded, false)
              })
              describe("performUpkeep", function () {
                  it("it can only run if checkupkeep is true", async function () {
                      await raffle.enterRaffle({ value: raffleEntranceFee })
                      await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                      await network.provider.send("evm_mine", [])
                      const tx = await raffle.performUpkeep([])
                      assert(tx)
                  })
                  it("reverts when checkupkeep is false", async function () {
                      await expect(raffle.performUpkeep([])).to.be.revertedWith(
                          "Raffle__UpkeepNotNeeded"
                      )
                  })
                  it("updates the raffle state and emits a requestId", async function () {
                      // Too many asserts in this test!
                      await raffle.enterRaffle({ value: raffleEntranceFee })
                      await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                      await network.provider.send("evm_mine", [])
                      const txResponse = await raffle.performUpkeep([]) // emits requestId
                      const txReceipt = await txResponse.wait(1) // waits 1 block
                      const requestId = txReceipt.events[1].args.requestId
                      const raffleState = await raffle.getRaffleState()
                      assert(requestId.toNumber() > 0)
                      assert(raffleState.toString() == "1") // 0 = open, 1 = calculating
                  })
              })
              describe("fulfillRandomWords", function () {
                  beforeEach(async function () {
                      await raffle.enterRaffle({ value: raffleEntranceFee })
                      await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                      await network.provider.request({ method: "evm_mine", params: [] })
                  })
                  it("can only be called after performupkeep", async function () {
                      await expect(
                          vrfCoordinatorV2Mock.fulfillRandomWords(0, raffle.address) // reverts if not fulfilled
                      ).to.be.revertedWith("nonexistent request")
                      await expect(
                          vrfCoordinatorV2Mock.fulfillRandomWords(1, raffle.address) // reverts if not fulfilled
                      ).to.be.revertedWith("nonexistent request")
                  })

                  // This test is too big...
                  // This test simulates users entering the raffle and wraps the entire functionality of the raffle
                  // inside a promise that will resolve if everything is successful.
                  // An event listener for the WinnerPicked is set up
                  // Mocks of chainlink keepers and vrf coordinator are used to kickoff this winnerPicked event
                  // All the assertions are done once the WinnerPicked event is fired
                  it("picks a winner, resets the lottery, and sends money", async function () {
                      const additionalEntrants = 3
                      const startingAccountIndex = 1
                      const accounts = await ethers.getSigners()
                      for (
                          let i = startingAccountIndex;
                          i < startingAccountIndex + additionalEntrants;
                          i++
                      ) {
                          const accountConnectedRaffle = raffle.connect(accounts[i])
                          await accountConnectedRaffle.enterRaffle({ value: raffleEntranceFee })
                      }
                      const startingTimeStamp = await raffle.getLastTimeStamp()

                      // This will be more important for our staging tests...
                      await new Promise(async (resolve, reject) => {
                          raffle.once("WinnerPicked", async () => {
                              console.log("Found the event!")
                              try {
                                  const recentWinner = await raffle.getRecentWinner()
                                  console.log(recentWinner)
                                  console.log(accounts[2].address)
                                  console.log(accounts[0].address)
                                  console.log(accounts[1].address)
                                  console.log(accounts[3].address)
                                  const raffleState = await raffle.getRaffleState()
                                  const endingTimeStamp = await raffle.getLastTimeStamp()
                                  const numPlayers = await raffle.getNumberOfPlayers()
                                  const winnerEndingBalance = await accounts[1].getBalance()
                                  assert.equal(numPlayers.toString(), "0")
                                  assert.equal(raffleState.toString(), "0")
                                  assert(endingTimeStamp > startingTimeStamp)
                                  assert.equal(
                                      winnerEndingBalance.toString(),
                                      winnerStartingBalance.add(
                                          raffleEntranceFee
                                              .mul(additionalEntrants)
                                              .add(raffleEntranceFee)
                                              .toString()
                                      )
                                  )
                              } catch (e) {
                                  reject(e)
                              }
                              resolve()
                          })
                          // Setting up the listener
                          // below we will fire the event, and the listener will pick it up, and resolve
                          const tx = await raffle.performUpkeep([])
                          const txReceipt = await tx.wait(1)
                          const winnerStartingBalance = await accounts[1].getBalance()
                          await vrfCoordinatorV2Mock.fulfillRandomWords(
                              txReceipt.events[1].args.requestId,
                              raffle.address
                          )
                      })
                  })
              })
          })
      })
