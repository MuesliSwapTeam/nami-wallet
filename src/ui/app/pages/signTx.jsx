import React from 'react';
import {
  bytesAddressToBinary,
  getAsset,
  getCurrentAccount,
  getUtxos,
  signTx,
  signTxHW,
} from '../../../api/extension';
import { Box, Stack, Text } from '@chakra-ui/layout';
import Account from '../components/account';
import Scrollbars from 'react-custom-scrollbars';
import { Button } from '@chakra-ui/button';
import ConfirmModal from '../components/confirmModal';
import Loader from '../../../api/loader';
import UnitDisplay from '../components/unitDisplay';
import { ChevronDownIcon, ChevronRightIcon } from '@chakra-ui/icons';
import MiddleEllipsis from 'react-middle-ellipsis';
import AssetFingerprint from '@emurgo/cip14-js';
import {
  Popover,
  PopoverArrow,
  PopoverBody,
  PopoverCloseButton,
  PopoverContent,
  PopoverHeader,
  PopoverTrigger,
} from '@chakra-ui/popover';
import Copy from '../components/copy';
import { Portal } from '@chakra-ui/portal';
import { Avatar } from '@chakra-ui/avatar';
import { FixedSizeList as List } from 'react-window';
import { valueToAssets } from '../../../api/util';
import { TxSignError } from '../../../config/config';
import { useStoreState } from 'easy-peasy';
import { Tooltip, useColorModeValue } from '@chakra-ui/react';

const abs = (big) => {
  return big < 0 ? big * BigInt(-1) : big;
};

const SignTx = ({ request, controller }) => {
  const settings = useStoreState((state) => state.settings.settings);
  const ref = React.useRef();
  const [account, setAccount] = React.useState(null);
  const [fee, setFee] = React.useState('0');
  const [value, setValue] = React.useState({
    ownValue: null,
    externalValue: null,
  });
  const [property, setProperty] = React.useState({
    metadata: false,
    certificate: false,
    withdrawal: false,
    minting: false,
    script: false,
    contract: false,
    datum: false,
  });
  // key kind can be payment and stake
  const [keyHashes, setKeyHashes] = React.useState({ kind: null, key: [] });
  const [isLoading, setIsLoading] = React.useState({
    loading: true,
    error: null,
  });

  const getFee = (tx) => {
    const fee = tx.body().fee().to_str();
    setFee(fee);
  };

  const getProperties = (tx) => {
    const metadata = tx.auxiliary_data();
    const certificate = tx.body().certs();
    const withdrawal = tx.body().withdrawals();
    const minting = tx.body().multiassets();
    const script = tx.witness_set().native_scripts();
    let datum;
    let contract = tx.body().script_data_hash();
    const outputs = tx.body().outputs();
    for (let i = 0; i < outputs.len(); i++) {
      const output = outputs.get(i);
      if (output.data_hash()) {
        datum = true;
        const prefix = bytesAddressToBinary(output.address().to_bytes()).slice(
          0,
          4
        );
        // from cardano ledger specs; if any of these prefixes match then it means the payment credential is a script hash, so it's a contract address
        if (
          prefix == '0111' ||
          prefix == '0011' ||
          prefix == '0001' ||
          prefix == '0101'
        ) {
          contract = true;
        }
        break;
      }
    }

    setProperty({
      metadata,
      certificate,
      withdrawal,
      minting,
      contract,
      script,
      datum,
    });
  };

  const getValue = async (tx, utxos, account) => {
    let inputValue = Loader.Cardano.Value.new(
      Loader.Cardano.BigNum.from_str('0')
    );
    const inputs = tx.body().inputs();
    for (let i = 0; i < inputs.len(); i++) {
      const input = inputs.get(i);
      const inputTxHash = Buffer.from(
        input.transaction_id().to_bytes()
      ).toString('hex');
      const inputTxId = input.index();
      const utxo = utxos.find((utxo) => {
        const utxoTxHash = Buffer.from(
          utxo.input().transaction_id().to_bytes()
        ).toString('hex');
        const utxoTxId = utxo.input().index();
        return inputTxHash === utxoTxHash && inputTxId === utxoTxId;
      });
      if (utxo) {
        inputValue = inputValue.checked_add(utxo.output().amount());
      }
    }
    const outputs = tx.body().outputs();
    let ownOutputValue = Loader.Cardano.Value.new(
      Loader.Cardano.BigNum.from_str('0')
    );
    const externalOutputs = {};
    const externalDatum = {};
    if (!outputs) return;
    for (let i = 0; i < outputs.len(); i++) {
      const output = outputs.get(i);
      const address = output.address().to_bech32();
      if (address === account.paymentAddr) {
        //own
        ownOutputValue = ownOutputValue.checked_add(output.amount());
      } else {
        //external
        if(output.data_hash()){
            // store data separately
            const datumh = Buffer.from(
                output.data_hash().to_bytes()
            ).toString('hex');
            externalDatum[address] = datumh;
        }
        if (!externalOutputs[address]) {
          const value = Loader.Cardano.Value.new(output.amount().coin());
          if (output.amount().multiasset())
            value.set_multiasset(output.amount().multiasset());
          externalOutputs[address] = value;
        } else
          externalOutputs[address] = externalOutputs[address].checked_add(
            output.amount()
          );
      }
    }

    inputValue = await valueToAssets(inputValue);
    ownOutputValue = await valueToAssets(ownOutputValue);

    const involvedAssets = [
      ...new Set([
        ...inputValue.map((asset) => asset.unit),
        ...ownOutputValue.map((asset) => asset.unit),
      ]),
    ];
    const ownOutputValueDifference = involvedAssets.map((unit) => {
      const leftValue = inputValue.find((asset) => asset.unit === unit);
      const rightValue = ownOutputValue.find((asset) => asset.unit === unit);
      const difference =
        BigInt(leftValue ? leftValue.quantity : '') -
        BigInt(rightValue ? rightValue.quantity : '');
      if (unit === 'lovelace') {
        return { unit, quantity: difference };
      }
      const policy = unit.slice(0, 56);
      const name = unit.slice(56);
      const fingerprint = new AssetFingerprint(
        Buffer.from(policy, 'hex'),
        Buffer.from(name, 'hex')
      ).fingerprint();
      return {
        unit,
        quantity: difference,
        fingerprint,
        name: (leftValue || rightValue).name,
        policy,
      };
    });

    const externalValue = {};
    for (const address of Object.keys(externalOutputs)) {
      externalValue[address] = await valueToAssets(externalOutputs[address]);
      if(externalDatum[address]){
        externalValue[address].push({
            unit: 'datum', quantity: externalDatum[address]
        })
      }
    }

    const ownValue = ownOutputValueDifference.filter((v) => v.quantity != 0);
    setValue({ ownValue, externalValue });
  };

  const getKeyHashes = (tx, utxos, account) => {
    let requiredKeyHashes = [];
    const baseAddr = Loader.Cardano.BaseAddress.from_address(
      Loader.Cardano.Address.from_bech32(account.paymentAddr)
    );
    const paymentKeyHash = Buffer.from(
      baseAddr.payment_cred().to_keyhash().to_bytes()
    ).toString('hex');
    const stakeKeyHash = Buffer.from(
      baseAddr.stake_cred().to_keyhash().to_bytes()
    ).toString('hex');

    //get key hashes from inputs
    const inputs = tx.body().inputs();
    for (let i = 0; i < inputs.len(); i++) {
      const txHash = Buffer.from(
        inputs.get(i).transaction_id().to_bytes()
      ).toString('hex');
      if (
        utxos.some(
          (utxo) =>
            Buffer.from(utxo.input().transaction_id().to_bytes()).toString(
              'hex'
            ) === txHash
        )
      ) {
        requiredKeyHashes.push(paymentKeyHash);
      } else {
        requiredKeyHashes.push('<not_owned_key_hash>');
      }
    }

    //get key hashes from certificates
    const txBody = tx.body();
    const keyHashFromCert = (txBody) => {
      for (let i = 0; i < txBody.certs().len(); i++) {
        const cert = txBody.certs().get(i);
        if (cert.kind() === 0) {
          const credential = cert.as_stake_registration().stake_credential();
          if (credential.kind() === 0) {
            const keyHash = Buffer.from(
              credential.to_keyhash().to_bytes()
            ).toString('hex');
            requiredKeyHashes.push(keyHash);
          }
        } else if (cert.kind() === 1) {
          const credential = cert.as_stake_deregistration().stake_credential();
          if (credential.kind() === 0) {
            const keyHash = Buffer.from(
              credential.to_keyhash().to_bytes()
            ).toString('hex');
            requiredKeyHashes.push(keyHash);
          }
        } else if (cert.kind() === 2) {
          const credential = cert.as_stake_delegation().stake_credential();
          if (credential.kind() === 0) {
            const keyHash = Buffer.from(
              credential.to_keyhash().to_bytes()
            ).toString('hex');
            requiredKeyHashes.push(keyHash);
          }
        } else if (cert.kind() === 3) {
          const owners = cert
            .as_pool_registration()
            .pool_params()
            .pool_owners();
          for (let i = 0; i < owners.len(); i++) {
            const keyHash = Buffer.from(owners.get(i).to_bytes()).toString(
              'hex'
            );
            requiredKeyHashes.push(keyHash);
          }
        } else if (cert.kind() === 6) {
          const instant_reward = cert
            .as_move_instantaneous_rewards_cert()
            .move_instantaneous_reward()
            .keys();
          for (let i = 0; i < instant_reward.len(); i++) {
            const credential = instant_reward.get(i);

            if (credential.kind() === 0) {
              const keyHash = Buffer.from(
                credential.to_keyhash().to_bytes()
              ).toString('hex');
              requiredKeyHashes.push(keyHash);
            }
          }
        }
      }
    };
    if (txBody.certs()) keyHashFromCert(txBody);

    //get key hashes from scripts
    const scripts = tx.witness_set().native_scripts();
    const keyHashFromScript = (scripts) => {
      for (let i = 0; i < scripts.len(); i++) {
        const script = scripts.get(i);
        if (script.kind() === 0) {
          const keyHash = Buffer.from(
            script.as_script_pubkey().addr_keyhash().to_bytes()
          ).toString('hex');
          requiredKeyHashes.push(keyHash);
        }
        if (script.kind() === 1) {
          return keyHashFromScript(script.as_script_all().native_scripts());
        }
        if (script.kind() === 2) {
          return keyHashFromScript(script.as_script_any().native_scripts());
        }
        if (script.kind() === 3) {
          return keyHashFromScript(script.as_script_n_of_k().native_scripts());
        }
      }
    };
    if (scripts) keyHashFromScript(scripts);

    //get keyHashes from required signers
    const requiredSigners = tx.body().required_signers();
    if (requiredSigners) {
      for (let i = 0; i < requiredSigners.len(); i++) {
        requiredKeyHashes.push(
          Buffer.from(requiredSigners.get(i).to_bytes()).toString('hex')
        );
      }
    }

    const keyKind = [];
    requiredKeyHashes = [...new Set(requiredKeyHashes)];
    if (requiredKeyHashes.includes(paymentKeyHash)) keyKind.push('payment');
    if (requiredKeyHashes.includes(stakeKeyHash)) keyKind.push('stake');
    if (keyKind.length <= 0) {
      setIsLoading((l) => ({
        ...l,
        error: 'Signature not possible',
      }));
      return;
    }
    setKeyHashes({ key: requiredKeyHashes, kind: keyKind });
  };

  const checkCollateral = (tx, utxos, account) => {
    const collateralInputs = tx.body().collateral();
    if (!collateralInputs) return;

    // checking all wallet utxos if used as collateral
    for (let i = 0; i < collateralInputs.len(); i++) {
      const collateral = collateralInputs.get(i);
      for (let j = 0; j < utxos.length; j++) {
        const input = utxos[j].input();
        if (
          Buffer.from(input.transaction_id().to_bytes()).toString('hex') ==
            Buffer.from(collateral.transaction_id().to_bytes()).toString(
              'hex'
            ) &&
          input.index() == collateral.index()
        ) {
          if (!account.collateral) {
            setIsLoading((l) => ({ ...l, error: 'Collateral not set' }));
            return;
          }

          if (
            !(
              Buffer.from(collateral.transaction_id().to_bytes()).toString(
                'hex'
              ) == account.collateral.txHash &&
              collateral.index() == account.collateral.txId
            )
          ) {
            setIsLoading((l) => ({ ...l, error: 'Invalid collateral used' }));
            return;
          }
        }
      }
    }
  };

  const getInfo = async () => {
    await Loader.load();
    const currentAccount = await getCurrentAccount();
    setAccount(currentAccount);
    let utxos = await getUtxos();
    const tx = Loader.Cardano.Transaction.from_bytes(
      Buffer.from(request.data.tx, 'hex')
    );
    getFee(tx);
    await getValue(tx, utxos, currentAccount);
    checkCollateral(tx, utxos, currentAccount);
    getKeyHashes(tx, utxos, currentAccount);
    getProperties(tx);
    setIsLoading((l) => ({ ...l, loading: false }));
  };
  const valueBgColor = useColorModeValue(
    { bg: 'gray.50', shadow: '#E2E8F0;' },
    { bg: 'gray.700', shadow: '#1A202C' }
  );

  React.useEffect(() => {
    getInfo();
  }, []);
  return (
    <>
      <Box
        minHeight="100vh"
        display="flex"
        alignItems="center"
        flexDirection="column"
        position="relative"
      >
        <Account />
        <Box mt="6" textAlign="center">
          <Text fontSize="2xl" fontWeight="bold">
            TRANSACTION SIGN
          </Text>
          <Text fontSize="lg" mt="-1">
            REQUEST
          </Text>
        </Box>
        <Box
          mt="4"
          display="flex"
          alignItems="center"
          justifyContent="center"
          flexDirection="column"
          background={valueBgColor.bg}
          rounded="xs"
          width="100%"
          padding="5"
          boxShadow={`inset 0 0 8px ${valueBgColor.shadow};`}
        >
          {value.ownValue ? (
            (() => {
              let lovelace = value.ownValue.find((v) => v.unit === 'lovelace');
              lovelace = lovelace ? lovelace.quantity : '0';
              const assets = value.ownValue.filter(
                (v) => v.unit !== 'lovelace'
              );
              return (
                <>
                  <Stack
                    direction="row"
                    alignItems="center"
                    justifyContent="center"
                    fontSize="2xl"
                    fontWeight="bold"
                    color={lovelace <= 0 ? 'teal.500' : 'red.300'}
                  >
                    <Text>{lovelace <= 0 ? '+' : '-'}</Text>
                    <UnitDisplay
                      quantity={abs(lovelace)}
                      decimals="6"
                      symbol={settings.adaSymbol}
                    />
                  </Stack>
                  {assets.length > 0 && (
                    <Stack
                      direction="row"
                      alignItems="center"
                      justifyContent="center"
                      fontSize="sm"
                      ml="4"
                    >
                      <Text>and</Text>
                      <Stack
                        direction="row"
                        alignItems="center"
                        justifyContent="center"
                        fontWeight="bold"
                      >
                        {assets.filter((v) => v.quantity > 0).length > 0 && (
                          <Text color="red.300">
                            - {assets.filter((v) => v.quantity > 0).length}{' '}
                          </Text>
                        )}
                        {assets.filter((v) => v.quantity < 0).length > 0 &&
                          assets.filter((v) => v.quantity > 0).length > 0 && (
                            <Text>|</Text>
                          )}
                        {assets.filter((v) => v.quantity < 0).length > 0 && (
                          <Text color="teal.500">
                            + {assets.filter((v) => v.quantity < 0).length}
                          </Text>
                        )}
                      </Stack>
                      <Text>{assets.length > 1 ? 'Assets' : 'Asset'}</Text>{' '}
                      <AssetsPopover assets={assets} isDifference />
                    </Stack>
                  )}
                  <Box mt="1" mb="2" />
                  <Stack
                    direction="row"
                    alignItems="center"
                    justifyContent="center"
                    fontSize="sm"
                  >
                    <Text fontWeight="bold">Fee:</Text>
                    <UnitDisplay
                      quantity={fee}
                      decimals="6"
                      symbol={settings.adaSymbol}
                    />
                  </Stack>
                </>
              );
            })()
          ) : (
            <Text fontSize="2xl" fontWeight="bold">
              ...
            </Text>
          )}
        </Box>
        {value.externalValue && Object.keys(value.externalValue).length > 0 && (
          <Box fontSize="xs" mt="6">
            <Text textAlign="center" fontSize="16" fontWeight="bold">
              {Object.keys(value.externalValue).length > 1
                ? 'Recipients'
                : 'Recipient'}
              <ChevronRightIcon ml="2" />
            </Text>
            <Box height="2" />
            <Scrollbars style={{ width: '100%' }} autoHeight autoHeightMax={80}>
              {Object.keys(value.externalValue).map((address, index) => {
                const lovelace = value.externalValue[address].find(
                  (v) => v.unit === 'lovelace'
                ).quantity;
                const assets = value.externalValue[address].filter(
                  (v) => v.unit !== 'lovelace' && v.unit !== 'datum'
                );
                const datum = value.externalValue[address].find(
                  (v) => v.unit === 'datum'
                ).quantity;
                return (
                  <Box key={index} mb="2">
                    <Stack direction="row" alignItems="center" mr="4">
                      <Copy label="Copied address" copy={address}>
                        <Box
                          width="200px"
                          whiteSpace="nowrap"
                          fontWeight="normal"
                        >
                          <MiddleEllipsis>
                            <span style={{ cursor: 'pointer' }}>{address}</span>
                          </MiddleEllipsis>
                        </Box>
                      </Copy>
                      <Box textAlign="center">
                        <UnitDisplay
                          fontWeight="bold"
                          quantity={lovelace}
                          decimals="6"
                          symbol={settings.adaSymbol}
                        />
                        {assets.length > 0 && (
                          <Text mt="-1" fontWeight="bold">
                            + {assets.length}{' '}
                            {assets.length > 1 ? 'Assets' : 'Asset'}{' '}
                            <AssetsPopover assets={assets} />
                          </Text>
                        )}
                         
                        {datum && (
                          <Text mt="-1" fontWeight="bold">
                            + 1 {' '}
                            {'DatumHash'}{' '}
                            <DatumPopover datum={datum} />
                          </Text>
                        )}
                      </Box>
                    </Stack>
                  </Box>
                );
              })}
            </Scrollbars>
          </Box>
        )}
        <Box
          bottom="95px"
          position="absolute"
          maxWidth="90%"
          wordBreak="break-all"
          textAlign="center"
          fontSize="xs"
        >
          {Object.keys(property).some((key) => property[key]) && (
            <Box mb="1.5">
              <Tooltip
                placement="top"
                hasArrow
                label={
                  <>
                    {property.minting && (
                      <Text>
                        <b>Minting</b>
                      </Text>
                    )}
                    {property.certificate && (
                      <Text>
                        <b>Certificate</b>
                      </Text>
                    )}
                    {property.withdrawal && (
                      <Text>
                        <b>Withdrawal</b>
                      </Text>
                    )}
                    {property.metadata && (
                      <Text>
                        <b>Metadata</b>
                      </Text>
                    )}
                    {property.contract && (
                      <Text>
                        <b>Contract</b>
                      </Text>
                    )}
                    {property.script && (
                      <Text>
                        <b>Script</b>
                      </Text>
                    )}
                    {property.datum && (
                      <Text>
                        <b>Datum</b>
                      </Text>
                    )}
                  </>
                }
              >
                <b style={{ cursor: 'pointer' }}>
                  Extras <ChevronDownIcon />
                </b>
              </Tooltip>
            </Box>
          )}
          {!isLoading.loading ? (
            isLoading.error ? (
              <span style={{ color: '#FC8181' }}>{isLoading.error}</span>
            ) : (
              <Text>
                <b>Required keys:</b>{' '}
                {keyHashes.kind.map((keyHash, index) =>
                  index >= keyHashes.kind.length - 1 &&
                  keyHashes.kind.length > 1 ? (
                    <span key={index}>, {keyHash}</span>
                  ) : (
                    <span key={index}>{keyHash}</span>
                  )
                )}
              </Text>
            )
          ) : (
            <Text fontSize="md">...</Text>
          )}
        </Box>
        <Box
          position="absolute"
          width="full"
          bottom="8"
          display="flex"
          alignItems="center"
          justifyContent="center"
        >
          <Button
            variant="ghost"
            mr="3"
            onClick={async () => {
              await controller.returnData({ error: TxSignError.UserDeclined });
              window.close();
            }}
          >
            Cancel
          </Button>
          <Button
            isDisabled={isLoading.loading || isLoading.error}
            colorScheme="orange"
            onClick={() => ref.current.openModal(account.index)}
          >
            Sign
          </Button>
        </Box>
      </Box>
      <ConfirmModal
        ref={ref}
        sign={async (password, hw) => {
          if (hw) {
            return await signTxHW(
              request.data.tx,
              keyHashes.key,
              account,
              hw,
              request.data.partialSign
            );
          }
          return await signTx(
            request.data.tx,
            keyHashes.key,
            password,
            account.index,
            request.data.partialSign
          );
        }}
        onConfirm={async (status, signedTx) => {
          if (status === true)
            await controller.returnData({
              data: Buffer.from(signedTx.to_bytes(), 'hex').toString('hex'),
            });
          else await controller.returnData({ error: signedTx });
          window.close();
        }}
      />
    </>
  );
};

// Assets Popover

const CustomScrollbars = ({ onScroll, forwardedRef, style, children }) => {
  const refSetter = React.useCallback((scrollbarsRef) => {
    if (scrollbarsRef) {
      forwardedRef(scrollbarsRef.view);
    } else {
      forwardedRef(scrollbarsRef.view);
    }
  }, []);

  return (
    <Scrollbars
      ref={refSetter}
      style={{ ...style, overflow: 'hidden', marginRight: 4 }}
      onScroll={onScroll}
    >
      {children}
    </Scrollbars>
  );
};

const CustomScrollbarsVirtualList = React.forwardRef((props, ref) => (
  <CustomScrollbars {...props} forwardedRef={ref} />
));

const AssetsPopover = ({ assets, isDifference }) => {
  return (
    <Popover>
      <PopoverTrigger>
        <Button
          style={{
            all: 'revert',
            background: 'none',
            border: 'none',
            outline: 'none',
            cursor: 'pointer',
            color: 'inherit',
          }}
        >
          <ChevronDownIcon cursor="pointer" />
        </Button>
      </PopoverTrigger>
      <Portal>
        <PopoverContent w="98%">
          <PopoverArrow ml="4px" />
          <PopoverCloseButton />
          <PopoverHeader fontWeight="bold">Assets</PopoverHeader>
          <PopoverBody p="-2">
            <Box
              display="flex"
              alignItems="center"
              justifyContent="center"
              flexDirection="column"
              my="1"
            >
              {assets && (
                <List
                  outerElementType={CustomScrollbarsVirtualList}
                  height={200}
                  itemCount={assets.length}
                  itemSize={45}
                  width={385}
                  layout="vertical"
                >
                  {({ index, style }) => {
                    const asset = assets[index];
                    return (
                      <Box
                        key={index}
                        style={style}
                        display="flex"
                        alignItems="center"
                        justifyContent="center"
                      >
                        <Asset asset={asset} isDifference={isDifference} />
                      </Box>
                    );
                  }}
                </List>
              )}
            </Box>
          </PopoverBody>
        </PopoverContent>
      </Portal>
    </Popover>
  );
};
const DatumPopover = ({ datum }) => {
  return (
    <Popover>
      <PopoverTrigger>
        <Button
          style={{
            all: 'revert',
            background: 'none',
            border: 'none',
            outline: 'none',
            cursor: 'pointer',
            color: 'inherit',
          }}
        >
          <ChevronDownIcon cursor="pointer" />
        </Button>
      </PopoverTrigger>
      <Portal>
        <PopoverContent w="98%">
          <PopoverArrow ml="4px" />
          <PopoverCloseButton />
          <PopoverHeader fontWeight="bold">DatumHash</PopoverHeader>
          <PopoverBody p="-2">
            <Box
              display="flex"
              alignItems="center"
              justifyContent="center"
              flexDirection="column"
              my="1"
            >
              {datum && (
                <List
                  outerElementType={CustomScrollbarsVirtualList}
                  height={200}
                  itemCount={1}
                  itemSize={45}
                  width={385}
                  layout="vertical"
                >
                  {({ index, style }) => {
                    return (
                      <Box
                        key={index}
                        style={style}
                        display="flex"
                        alignItems="center"
                        justifyContent="center"
                      >
                        <DatumHash datum={datum}/>
                      </Box>
                    );
                  }}
                </List>
              )}
            </Box>
          </PopoverBody>
        </PopoverContent>
      </Portal>
    </Popover>
  );
};

const Asset = ({ asset, isDifference }) => {
  const [token, setToken] = React.useState(null);
  const isMounted = useIsMounted();

  const fetchData = async () => {
    const detailedAsset = {
      ...(await getAsset(asset.unit)),
      quantity: asset.quantity,
    };
    if (!isMounted.current) return;
    setToken(detailedAsset);
  };

  React.useEffect(() => {
    fetchData();
  }, []);

  return (
    <Box
      width="100%"
      ml="3"
      display="flex"
      alignItems="center"
      justifyContent="start"
    >
      {token && (
        <Stack
          width="100%"
          fontSize="xs"
          direction="row"
          alignItems="center"
          justifyContent="start"
        >
          <Avatar userSelect="none" size="xs" name={asset.name} />

          <Box
            textAlign="left"
            width="200px"
            whiteSpace="nowrap"
            fontWeight="normal"
          >
            <Copy label="Copied asset" copy={asset.fingerprint}>
              <Box mb="-0.5">
                <MiddleEllipsis>
                  <span>{asset.name}</span>
                </MiddleEllipsis>
              </Box>
              <Box whiteSpace="nowrap" fontSize="xx-small" fontWeight="light">
                <MiddleEllipsis>
                  <span>Policy: {asset.policy}</span>
                </MiddleEllipsis>
              </Box>
            </Copy>
          </Box>
          <Box>
            <Box
              fontWeight="bold"
              color={
                isDifference
                  ? token.quantity > 0
                    ? 'red.300'
                    : 'teal.500'
                  : 'inherit'
              }
            >
              <Box display="flex" alignItems="center">
                <Box mr="0.5">
                  {isDifference ? (token.quantity > 0 ? '-' : '+') : '+'}{' '}
                </Box>
                <UnitDisplay
                  quantity={abs(token.quantity).toString()}
                  decimals={token.decimals}
                />
              </Box>
            </Box>
          </Box>
        </Stack>
      )}
    </Box>
  );
};
const DatumHash = ({ datum }) => {

  return (
    <Box
      width="100%"
      ml="3"
      display="flex"
      alignItems="center"
      justifyContent="start"
    >
      {datum && (
        <Stack
          width="100%"
          fontSize="xs"
          direction="row"
          alignItems="center"
          justifyContent="start"
        >
          <Box
            textAlign="left"
            width="200px"
            whiteSpace="nowrap"
            fontWeight="normal"
          >
            <Box mb="-0.5">
            <MiddleEllipsis>
                <Copy label="Copied datum hash" copy={datum}>
                    <span>{datum}</span>
                </Copy>
            </MiddleEllipsis>
            </Box>
          </Box>
        </Stack>
      )}
    </Box>
  );
};

const useIsMounted = () => {
  const isMounted = React.useRef(false);
  React.useEffect(() => {
    isMounted.current = true;
    return () => (isMounted.current = false);
  }, []);
  return isMounted;
};

export default SignTx;
