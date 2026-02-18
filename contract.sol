// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./interfaces/IUSDFEarn.sol";
import "./interfaces/IAsBNBMinter.sol";
import "./interfaces/IYieldProxy.sol";
import "./interfaces/IAsterWithdrawValidator.sol";
import "./libraries/SignatureChecker.sol";

contract AstherusVault is
    Initializable,
    PausableUpgradeable,
    AccessControlEnumerableUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable
{
    using Address for address payable;
    using SafeERC20 for IERC20;
    using SignatureChecker for address;
    using ECDSA for bytes32;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    bytes32 public constant OPERATE_ROLE = keccak256("OPERATE_ROLE");
    bytes32 public constant TOKEN_ROLE = keccak256("TOKEN_ROLE");
    bytes32 public constant DEPOSIT_ROLE = keccak256("DEPOSIT_ROLE");

    uint8 public constant USD_DECIMALS = 8;
    address public constant NATIVE = address(bytes20(keccak256("NATIVE")));

    event ReceiveETH(address indexed from, address indexed to, uint256 amount);
    event Deposit(
        address indexed account,
        address indexed currency,
        bool isNative,
        uint256 amount,
        uint256 broker
    );
    event DepositFailed(
        address indexed account,
        address indexed currency,
        bool isNative,
        uint256 amount
    );
    event WithdrawPaused(
        address indexed trigger,
        address indexed currency,
        uint256 amount,
        uint256 amountUsd
    );
    event Withdraw(
        uint256 indexed id,
        address indexed to,
        address indexed currency,
        bool isNative,
        uint256 amount
    );
    event Withdraw(
        uint256 indexed id,
        address indexed to,
        address indexed currency,
        uint256 amount,
        uint256 fee
    );
    event WithdrawFee(
        address indexed currency,
        uint256 amount,
        address receiver
    );
    event WithdrawCanceled(uint256 indexed id, bytes32 userDigest);
    event UpdateHourlyLimit(uint256 oldHourlyLimit, uint256 newHourlyLimit);
    event UpdateProofHourlyLimit(
        uint256 oldHourlyLimit,
        uint256 newHourlyLimit
    );
    event AddToken(
        address indexed currency,
        address indexed priceFeed,
        bool fixedPrice
    );
    event RemoveToken(address indexed currency);
    event ValidatorAdd(
        bytes32 indexed hash,
        uint validatorNum,
        uint totalPower
    );
    event ValidatorRemove(bytes32 indexed hash, uint validatorNum);
    event TokenHashChanged(address indexed tokenAddress, bytes32 tokenHash);

    error ZeroAddress();
    error ZeroAmount();
    error TokenAlreadyExist();
    error CurrencyNotSupport(address currency);
    error ValueNotZero();
    error LowerThanExpected(uint256 expected, uint256 actual);
    error AsBnbActivitiesOnGoing();
    error AmountIllegal(uint256 supported, uint256 actual);
    error AlreadyWithdraw(uint256 withdrawId);
    error UserAlreadyWithdraw(bytes32 userDigest);
    error FeeExceeds(uint256 real, uint256 max);
    error CurrencyNameNotSupport(address token, bytes32 hash);
    error PriceDecimalsMismatch(uint8 expected, uint8 actual);

    struct Token {
        address currency;
        address priceFeed;
        uint256 price;
        bool fixedPrice;
        uint8 priceDecimals;
        uint8 currencyDecimals;
    }

    struct ValidatorInfo {
        address signer;
        uint256 power;
    }

    struct WithdrawAction {
        address token;
        uint256 amount;
        uint256 fee;
        address receiver;
    }

    address public immutable TIMELOCK_ADDRESS;
    IUSDFEarn public immutable USDF_EARN;
    IERC20 private immutable USDT;
    IERC20 private immutable USDF;
    IAsBNBMinter public immutable ASBNB_MINTER;
    IERC20 private immutable SLISBNB;
    IERC20 private immutable ASBNB;
    IYieldProxy private immutable YIELD_PROXY;
    IAsterWithdrawValidator public immutable WITHDRAW_VALIDATOR;

    address public reserved5;
    uint256 public hourlyLimit;
    mapping(address => Token) public supportToken;
    // id => block.number
    mapping(uint256 => uint256) public withdrawHistory;
    // block.timestamp / 1 hours => USD Value
    mapping(uint256 => uint256) public withdrawPerHours;
    address public reserved1;
    uint256 public reserved2;
    mapping(uint256 => uint256) public reserved3;
    mapping(bytes32 => uint) public availableValidators;
    mapping(address => uint256) public fees;
    // token address => tokenName hash
    mapping(address => bytes32) public tokenHashMap;
    // user withdraw signature digest => block.number
    mapping(bytes32 => uint256) public userWithdrawHistory;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(
        address timelockAddress,
        IUSDFEarn usdfEarn,
        IAsBNBMinter asBnbMinter,
        IAsterWithdrawValidator withdrawValidator
    ) {
        TIMELOCK_ADDRESS = timelockAddress;
        USDF_EARN = usdfEarn;
        if (address(usdfEarn) == address(0)) {
            //if zero address, means don't support USDF_EARN
            USDT = IERC20(address(0));
            USDF = IERC20(address(0));
        } else {
            USDT = usdfEarn.USDT();
            USDF = usdfEarn.USDF();
        }
        ASBNB_MINTER = asBnbMinter;
        if (address(asBnbMinter) == address(0)) {
            //if zero address, means don't support ASBNB_MINTER
            SLISBNB = IERC20(address(0));
            ASBNB = IERC20(address(0));
            YIELD_PROXY = IYieldProxy(address(0));
        } else {
            SLISBNB = asBnbMinter.token();
            ASBNB = asBnbMinter.asBnb();
            YIELD_PROXY = asBnbMinter.yieldProxy();
        }
        if (address(withdrawValidator) == address(0)) revert ZeroAddress();
        WITHDRAW_VALIDATOR = withdrawValidator;
        _disableInitializers();
    }

    receive() external payable {
        if (!_supportCurrency(NATIVE)) {
            revert CurrencyNotSupport(NATIVE);
        }
        if (msg.value > 0) {
            emit ReceiveETH(msg.sender, address(this), msg.value);
        }
    }

    modifier onlyTimeLock() {
        require(msg.sender == TIMELOCK_ADDRESS, "only timelock");
        _;
    }

    function initialize(address defaultAdmin) public initializer {
        __Pausable_init();
        __AccessControlEnumerable_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, defaultAdmin);
        _grantRole(ADMIN_ROLE, defaultAdmin);
        _grantRole(DEFAULT_ADMIN_ROLE, TIMELOCK_ADDRESS);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function pause() external onlyRole(PAUSE_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSE_ROLE) {
        _unpause();
    }

    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyTimeLock {}

    function updateHourlyLimit(
        uint256 newHourlyLimit
    ) external onlyRole(ADMIN_ROLE) {
        if (newHourlyLimit == 0) revert ZeroAmount();
        uint256 oldHourlyLimit = hourlyLimit;
        hourlyLimit = newHourlyLimit;
        emit UpdateHourlyLimit(oldHourlyLimit, newHourlyLimit);
    }

    function addValidator(
        ValidatorInfo[] calldata validators
    ) external onlyRole(ADMIN_ROLE) {
        bytes32 validatorHash = keccak256(abi.encode(validators));
        require(availableValidators[validatorHash] == 0, "already set");
        uint totalPower = 0;
        address lastValidator = address(0);
        for (uint i = 0; i < validators.length; i++) {
            require(
                validators[i].signer > lastValidator,
                "validator not ordered"
            );
            totalPower += validators[i].power;
            lastValidator = validators[i].signer;
        }
        availableValidators[validatorHash] = totalPower;
        emit ValidatorAdd(validatorHash, validators.length, totalPower);
    }

    function removeValidator(
        ValidatorInfo[] calldata validators
    ) external onlyRole(ADMIN_ROLE) {
        bytes32 validatorHash = keccak256(abi.encode(validators));
        require(availableValidators[validatorHash] != 0, "not set");
        delete availableValidators[validatorHash];
        emit ValidatorRemove(validatorHash, validators.length);
    }

    function withdrawFee(
        address[] calldata tokens,
        uint256[] calldata amounts,
        address receiver
    ) external onlyRole(ADMIN_ROLE) {
        require(tokens.length == amounts.length, "illegal num");
        for (uint i = 0; i < tokens.length; i++) {
            address token = tokens[i];
            uint availableFee = fees[token];
            uint amount = amounts[i];
            if (availableFee < amount) {
                amount = availableFee;
            }
            _transfer(payable(receiver), token == NATIVE, token, amount);
            emit WithdrawFee(token, amount, receiver);
            fees[token] -= amount;
        }
    }

    function addToken(
        address currency,
        address priceFeed,
        uint256 price,
        bool fixedPrice,
        uint8 priceDecimals,
        uint8 currencyDecimals
    ) public onlyRole(TOKEN_ROLE) {
        if (currency == address(0)) revert ZeroAddress();
        Token storage token = supportToken[currency];
        if (token.currency != address(0)) revert TokenAlreadyExist();
        token.currency = currency;
        token.fixedPrice = fixedPrice;
        token.priceDecimals = priceDecimals;
        token.currencyDecimals = currencyDecimals;
        if (fixedPrice) {
            token.price = price;
        } else {
            if (priceFeed == address(0)) revert ZeroAddress();
            AggregatorV3Interface oracle = AggregatorV3Interface(priceFeed);
            if (oracle.decimals() != priceDecimals)
                revert PriceDecimalsMismatch(priceDecimals, oracle.decimals());
            token.priceFeed = priceFeed;
        }
        emit AddToken(currency, priceFeed, fixedPrice);
    }

    /**
     * @dev add token and set token name hash
     * @param currency token address
     * @param priceFeed chainlink price feed address
     * @param price fixed price value, used when fixedPrice is true
     * @param fixedPrice whether the token uses a fixed price
     * @param priceDecimals price decimals
     * @param currencyDecimals token decimals
     * @param tokenName token name string
     */
    function addToken(
        address currency,
        address priceFeed,
        uint256 price,
        bool fixedPrice,
        uint8 priceDecimals,
        uint8 currencyDecimals,
        string calldata tokenName
    ) external onlyRole(TOKEN_ROLE) {
        addToken(
            currency,
            priceFeed,
            price,
            fixedPrice,
            priceDecimals,
            currencyDecimals
        );
        bytes32 tokenHash = keccak256(bytes(tokenName));
        tokenHashMap[currency] = tokenHash;
        emit TokenHashChanged(currency, tokenHash);
    }

    function removeToken(address currency) external onlyRole(ADMIN_ROLE) {
        if (currency == address(0)) revert ZeroAddress();
        delete supportToken[currency];
        emit RemoveToken(currency);
    }

    /**
     * @dev set token name hash for supported token
     * @param tokenAddress token address
     * @param tokenName token name string
     */
    function setTokenHash(
        address tokenAddress,
        string calldata tokenName
    ) external onlyRole(ADMIN_ROLE) {
        Token storage token = supportToken[tokenAddress];
        if (token.currency == address(0))
            revert CurrencyNotSupport(tokenAddress);
        bytes32 tokenHash = keccak256(bytes(tokenName));
        tokenHashMap[tokenAddress] = tokenHash;
        emit TokenHashChanged(tokenAddress, tokenHash);
    }

    function _transfer(
        address payable to,
        bool isNative,
        address currency,
        uint256 amount
    ) private {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (isNative) {
            to.sendValue(amount);
        } else {
            IERC20 token = IERC20(currency);
            require(
                token.balanceOf(address(this)) >= amount,
                "not enough currency balance"
            );
            token.safeTransfer(to, amount);
        }
    }

    function _transfer(
        address to,
        address currency,
        uint256 amount,
        uint256 fee
    ) private {
        if (to == address(0)) revert ZeroAddress();
        fees[currency] += fee;
        uint remain = amount - fee;
        if (currency == NATIVE) {
            payable(to).sendValue(remain);
        } else {
            IERC20 token = IERC20(currency);
            token.safeTransfer(to, remain);
        }
    }

    function deposit(
        address currency,
        uint256 amount,
        uint256 broker
    ) external nonReentrant {
        require(_supportCurrency(currency), "currency not support");
        if (amount == 0) revert ZeroAmount();
        IERC20 erc20 = IERC20(currency);
        // The top-up amount of Burning Coins is based on the amount received in this contract
        uint256 before = erc20.balanceOf(address(this));
        erc20.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposit(
            msg.sender,
            currency,
            false,
            erc20.balanceOf(address(this)) - before,
            broker
        );
    }

    function depositNative(uint256 broker) external payable nonReentrant {
        require(_supportCurrency(NATIVE), "currency not support");
        uint256 amount = msg.value;
        require(amount > 0, "msg.value must be greater than 0");
        emit Deposit(msg.sender, NATIVE, true, amount, broker);
    }

    /**
     * @dev DEPOSITER provide asset and deposit for other user
     * @param currency token address, if NATIVE token provide ${NATIVE} address
     * @param forAddress user's address that receive the deposited asset
     * @param amount deposit amount. if NATIVE token provide by msg.value
     * @param broker: for different broker flag
     */
    function depositFor(
        address currency,
        address forAddress,
        uint256 amount,
        uint256 broker
    ) external payable onlyRole(DEPOSIT_ROLE) nonReentrant {
        if (!_supportCurrency(currency)) revert CurrencyNotSupport(currency);
        if (amount == 0) revert ZeroAmount();
        bool isNative = currency == NATIVE;
        if (isNative) {
            if (amount != msg.value) revert AmountIllegal(amount, msg.value);
        } else {
            if (msg.value != 0) revert ValueNotZero();
            IERC20 erc20 = IERC20(currency);
            uint balanceBefore = erc20.balanceOf(address(this));
            erc20.safeTransferFrom(msg.sender, address(this), amount);
            uint balanceAfter = erc20.balanceOf(address(this));
            if (amount != balanceAfter - balanceBefore)
                revert AmountIllegal(amount, balanceAfter - balanceBefore);
        }
        emit Deposit(forAddress, currency, isNative, amount, broker);
    }

    /**
     * @dev user provide USDT, convert to USDF and deposit USDF
     * @param usdtAmount The amount of USDT that user provided
     * @param minUsdfAmount The minimum amount of USDF that user expects to deposit
     * @param broker The broker address for the deposit
     */
    function depositUSDF(
        uint256 usdtAmount,
        uint256 minUsdfAmount,
        uint256 broker
    ) external nonReentrant {
        if (!_supportCurrency(address(USDF)))
            revert CurrencyNotSupport(address(USDF));
        //transfer USDT from user to this contract
        uint256 usdtBalanceBefore = USDT.balanceOf(address(this));
        USDT.safeTransferFrom(msg.sender, address(this), usdtAmount);
        uint256 usdtBalanceAfter = USDT.balanceOf(address(this));
        uint256 usdtAmountReceived = usdtBalanceAfter - usdtBalanceBefore;
        //mint USDT to USDF by USDF_EARN
        USDT.safeIncreaseAllowance(address(USDF_EARN), usdtAmountReceived);
        uint256 usdfBalanceBefore = USDF.balanceOf(address(this));
        USDF_EARN.deposit(usdtAmountReceived);
        uint256 usdfBalanceAfter = USDF.balanceOf(address(this));
        uint256 usdfAmountReceived = usdfBalanceAfter - usdfBalanceBefore;
        //check
        if (usdfAmountReceived == 0) revert ZeroAmount();
        if (usdfAmountReceived < minUsdfAmount)
            revert LowerThanExpected(minUsdfAmount, usdfAmountReceived);
        //deposit
        emit Deposit(
            msg.sender,
            address(USDF),
            false,
            usdfAmountReceived,
            broker
        );
    }

    /**
     * @dev user provide SLISBNB or NATIVE, convert to ASBNB and deposit ASBNB
     * @param currency The currency type, either NATIVE or SLISBNB
     * @param tokenAmount The amount of SLISBNB or NATIVE that user provided
     * @param minAsBnbAmount The minimum amount of ASBNB that user expects to deposit
     * @param broker The broker address for the deposit
     * @notice If currency is NATIVE, user must send the exact amount in msg.value
     * @notice If currency is SLISBNB, the msg.value should be zero
     */
    function depositAsBNB(
        address currency,
        uint256 tokenAmount,
        uint256 minAsBnbAmount,
        uint256 broker
    ) external payable nonReentrant {
        if (!_supportCurrency(address(ASBNB)))
            revert CurrencyNotSupport(address(ASBNB));
        if (YIELD_PROXY.activitiesOnGoing()) revert AsBnbActivitiesOnGoing();
        //mint SLISBNB or BNB to ASBNB by ASBNB_MINTER
        uint256 asBnbBalanceBefore = ASBNB.balanceOf(address(this));
        if (currency == NATIVE) {
            if (msg.value != tokenAmount)
                revert LowerThanExpected(tokenAmount, msg.value);
            //mint BNB to ASBNB by ASBNB_MINTER
            ASBNB_MINTER.mintAsBnb{value: msg.value}();
        } else if (currency == address(SLISBNB)) {
            if (msg.value != 0) revert ValueNotZero();
            //transfer SLISBNB from user to this contract
            uint256 slisbnbBalanceBefore = SLISBNB.balanceOf(address(this));
            SLISBNB.safeTransferFrom(msg.sender, address(this), tokenAmount);
            uint256 slisbnbBalanceAfter = SLISBNB.balanceOf(address(this));
            uint256 slisbnbAmountReceived = slisbnbBalanceAfter -
                slisbnbBalanceBefore;
            //mint SLISBNB to ASBNB by ASBNB_MINTER
            SLISBNB.safeIncreaseAllowance(
                address(ASBNB_MINTER),
                slisbnbAmountReceived
            );
            ASBNB_MINTER.mintAsBnb(slisbnbAmountReceived);
        } else {
            revert CurrencyNotSupport(currency);
        }
        uint256 asBnbBalanceAfter = ASBNB.balanceOf(address(this));
        uint256 asBnbAmountReceived = asBnbBalanceAfter - asBnbBalanceBefore;
        //check
        if (asBnbAmountReceived == 0) revert ZeroAmount();
        if (asBnbAmountReceived < minAsBnbAmount)
            revert LowerThanExpected(minAsBnbAmount, asBnbAmountReceived);
        //deposit
        emit Deposit(
            msg.sender,
            address(ASBNB),
            false,
            asBnbAmountReceived,
            broker
        );
    }

    function withdraw(
        uint256 id,
        ValidatorInfo[] calldata validators,
        WithdrawAction calldata action,
        bytes[] calldata validatorSignatures
    ) external whenNotPaused onlyRole(OPERATE_ROLE) nonReentrant {
        require(withdrawHistory[id] == 0, "already withdraw");
        require(_supportCurrency(action.token), "currency not support");
        bytes32 digest = keccak256(
            abi.encode(
                id,
                block.chainid,
                address(this),
                action.token,
                action.amount,
                action.fee,
                action.receiver
            )
        );
        verifyValidatorSignature(validators, digest, validatorSignatures);
        if (!checkLimit(action.token, action.amount)) {
            return;
        } else {
            withdrawHistory[id] = block.number;
            _transfer(action.receiver, action.token, action.amount, action.fee);
            emit Withdraw(
                id,
                action.receiver,
                action.token,
                action.amount,
                action.fee
            );
        }
    }

    /**
     * @dev withdraw with multi-signature validation
     * @param tokenAddress token address
     * @param realFee real fee to withdraw, should not exceed userRequestInfo.fee
     * @param userRequestInfo user withdraw request info
     * @param businessInfo business withdraw info
     * @param signatureInfo signatures info,include user, business and ledger signatures
     */
    function withdraw(
        address tokenAddress,
        uint256 realFee,
        IAsterWithdrawValidator.UserRequestInfo calldata userRequestInfo,
        IAsterWithdrawValidator.BusinessInfo calldata businessInfo,
        IAsterWithdrawValidator.SignatureInfo calldata signatureInfo
    ) external whenNotPaused onlyRole(OPERATE_ROLE) nonReentrant {
        if (withdrawHistory[businessInfo.withdrawId] != 0) {
            revert AlreadyWithdraw(businessInfo.withdrawId);
        }
        Token memory token = supportToken[tokenAddress];
        if (
            token.currency == address(0) ||
            token.currencyDecimals != businessInfo.decimals
        ) {
            revert CurrencyNotSupport(tokenAddress);
        }
        if (tokenHashMap[tokenAddress] != businessInfo.tokenNameHash) {
            revert CurrencyNameNotSupport(
                tokenAddress,
                businessInfo.tokenNameHash
            );
        }
        if (realFee > userRequestInfo.fee) {
            revert FeeExceeds(realFee, userRequestInfo.fee);
        }
        if (!checkLimit(tokenAddress, userRequestInfo.amount)) {
            //contract will be paused
            return;
        }
        bytes32 userDigest = WITHDRAW_VALIDATOR.withdrawCheck(
            userRequestInfo,
            businessInfo,
            signatureInfo
        );
        if (userWithdrawHistory[userDigest] != 0) {
            revert UserAlreadyWithdraw(userDigest);
        }
        withdrawHistory[businessInfo.withdrawId] = block.number;
        userWithdrawHistory[userDigest] = block.number;
        _transfer(
            userRequestInfo.receiver,
            tokenAddress,
            userRequestInfo.amount,
            realFee
        );
        emit Withdraw(
            businessInfo.withdrawId,
            userRequestInfo.receiver,
            tokenAddress,
            userRequestInfo.amount,
            realFee
        );
    }

    /**
     * @dev cancel withdraw request, make sure withdrawId and userDigest can't be used again
     * @param withdrawId business withdraw id, should not be used before
     * @param userDigest user withdraw signature digest, can be zero if not used
     */
    function cancelWithdraw(
        uint256 withdrawId,
        bytes32 userDigest
    ) external onlyRole(OPERATE_ROLE) {
        if (withdrawHistory[withdrawId] != 0) {
            revert AlreadyWithdraw(withdrawId);
        }
        withdrawHistory[withdrawId] = block.number;
        if (userDigest != bytes32(0)) {
            userWithdrawHistory[userDigest] = block.number;
        }
        emit WithdrawCanceled(withdrawId, userDigest);
    }

    function _supportCurrency(address currency) private view returns (bool) {
        return supportToken[currency].currency != address(0);
    }

    function _amountUsd(
        address currency,
        uint256 amount
    ) private view returns (uint256) {
        Token memory token = supportToken[currency];
        uint256 price = token.price;
        if (!token.fixedPrice) {
            AggregatorV3Interface oracle = AggregatorV3Interface(
                token.priceFeed
            );
            (, int256 price_, , , ) = oracle.latestRoundData();
            price = uint256(price_);
        }
        return
            (price * amount * (10 ** USD_DECIMALS)) /
            (10 ** (token.priceDecimals + token.currencyDecimals));
    }

    function balance(address currency) external view returns (uint256) {
        return IERC20(currency).balanceOf(address(this));
    }

    function verifyValidatorSignature(
        ValidatorInfo[] calldata validators,
        bytes32 digest,
        bytes[] calldata validatorSignatures
    ) internal view {
        bytes32 validatorHash = keccak256(abi.encode(validators));
        uint totalPower = availableValidators[validatorHash];
        require(totalPower > 0, "validator illegal");
        uint power = 0;
        uint validatorIndex = 0;
        bytes32 validatorDigest = MessageHashUtils.toEthSignedMessageHash(
            digest
        );
        for (
            uint i = 0;
            i < validatorSignatures.length &&
                validatorIndex < validators.length;
            i++
        ) {
            address recover = validatorDigest.recover(validatorSignatures[i]);
            if (recover == address(0)) {
                continue;
            }
            while (validatorIndex < validators.length) {
                address validator = validators[validatorIndex].signer;
                validatorIndex++;
                if (validator == recover) {
                    power += validators[validatorIndex - 1].power;
                    break;
                }
            }
        }
        require(power >= (totalPower * 2) / 3, "validator signature illegal");
    }

    function checkLimit(
        address currency,
        uint256 amount
    ) internal returns (bool) {
        uint256 amountUsd = _amountUsd(currency, amount);
        if (amountUsd == 0) revert ZeroAmount();
        uint256 cursor = block.timestamp / 1 hours;
        if (withdrawPerHours[cursor] + amountUsd > hourlyLimit) {
            _pause();
            emit WithdrawPaused(msg.sender, currency, amount, amountUsd);
            return false;
        } else {
            withdrawPerHours[cursor] += amountUsd;
            return true;
        }
    }
}
